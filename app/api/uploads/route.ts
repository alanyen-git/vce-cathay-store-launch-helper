import { env } from "cloudflare:workers";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { uploads } from "@/db/schema";
import { ApiError, assertRole, errorResponse, newId, now, requireOrganization } from "@/lib/server";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
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
    if (!hasExpectedImageSignature(contentType, new Uint8Array(body))) {
      throw new ApiError("照片內容與檔案格式不符。", 415);
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
