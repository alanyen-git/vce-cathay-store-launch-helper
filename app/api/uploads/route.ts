import { env } from "cloudflare:workers";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { uploads } from "@/db/schema";
import { ApiError, assertRole, errorResponse, newId, now, requireOrganization } from "@/lib/server";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_STAGED_UPLOADS = 12;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const organizationId = typeof form.get("organizationId") === "string" ? String(form.get("organizationId")) : null;
    const file = form.get("file");
    const context = await requireOrganization(organizationId);
    assertRole(context.role, ["admin", "manager", "editor"]);
    if (!(file instanceof File)) throw new ApiError("請選擇照片檔案。");
    const contentType = file.type.toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw new ApiError("照片只支援 JPEG、PNG 或 WebP 格式。");
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new ApiError("單張照片大小需介於 1 B 至 6 MB。", 413);
    if (!env.BUCKET) throw new ApiError("照片儲存服務尚未就緒。", 503);

    const db = getDb();
    await cleanupExpiredStagedUploads(context.organizationId, context.user.userId);
    const staged = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(and(
        eq(uploads.organizationId, context.organizationId),
        eq(uploads.uploaderUserId, context.user.userId),
        eq(uploads.status, "staged"),
      ))
      .limit(MAX_STAGED_UPLOADS);
    if (staged.length >= MAX_STAGED_UPLOADS) {
      throw new ApiError("暫存照片已達上限，請完成或取消現有建檔後再上傳。", 429);
    }

    const body = await file.arrayBuffer();
    const bytes = new Uint8Array(body);
    if (!hasExpectedImageSignature(contentType, bytes)) {
      throw new ApiError("照片內容與檔案格式不符。", 415);
    }
    const dimensions = readImageDimensions(contentType, bytes);
    if (!dimensions) {
      throw new ApiError("無法讀取照片尺寸，請改用有效的 JPEG、PNG 或 WebP 圖片。", 415);
    }
    if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION ||
        dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
      throw new ApiError("照片解析度過大，請縮小圖片後再上傳。", 413);
    }
    const uploadId = newId();
    const timestamp = now();
    const r2Key = `${context.organizationId}/staging/${uploadId}`;
    await env.BUCKET.put(r2Key, body, {
      httpMetadata: { contentType },
      customMetadata: { organizationId: context.organizationId, uploadedBy: context.user.userId },
    });
    try {
      await db.insert(uploads).values({
        id: uploadId,
        organizationId: context.organizationId,
        uploaderUserId: context.user.userId,
        r2Key,
        contentType,
        byteSize: file.size,
        status: "staged",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      await env.BUCKET.delete(r2Key).catch(() => undefined);
      throw error;
    }
    return Response.json({ id: uploadId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

async function cleanupExpiredStagedUploads(organizationId: string, userId: string) {
  const bucket = env.BUCKET;
  if (!bucket) return;
  const cutoff = new Date(Date.now() - STAGING_TTL_MS).toISOString();
  const db = getDb();
  const expired = await db
    .select({ id: uploads.id, r2Key: uploads.r2Key })
    .from(uploads)
    .where(and(
      eq(uploads.organizationId, organizationId),
      eq(uploads.uploaderUserId, userId),
      eq(uploads.status, "staged"),
      lt(uploads.createdAt, cutoff),
    ))
    .limit(200);
  if (!expired.length) return;
  await Promise.all(expired.map((upload) => bucket.delete(upload.r2Key)));
  await db.delete(uploads).where(inArray(uploads.id, expired.map((upload) => upload.id)));
}

function hasExpectedImageSignature(contentType: string, bytes: Uint8Array) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (contentType === "image/webp") {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

function readImageDimensions(contentType: string, bytes: Uint8Array) {
  if (contentType === "image/png") {
    if (bytes.length < 24) return null;
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (contentType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
      const isStartOfFrame = [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ].includes(marker);
      if (isStartOfFrame) {
        if (segmentLength < 7) return null;
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segmentLength;
    }
    return null;
  }

  if (contentType === "image/webp") {
    if (bytes.length < 20) return null;
    const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkType === "VP8X") {
      if (bytes.length < 30) return null;
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height };
    }
    if (chunkType === "VP8 " && bytes.length >= 30 &&
        bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff);
      const height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { width, height };
    }
  }

  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3];
}
