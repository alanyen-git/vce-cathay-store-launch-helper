import { env } from "cloudflare:workers";
import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { organizationMembers, uploads } from "@/db/schema";
import { ApiError, errorResponse, requireUser } from "@/lib/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photoId: string }> },
) {
  try {
    const { photoId } = await params;
    const user = await requireUser();
    const db = getDb();
    const [upload] = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, photoId), eq(uploads.status, "claimed")))
      .limit(1);
    if (!upload) throw new ApiError("找不到照片。", 404);
    const [member] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(
        eq(organizationMembers.organizationId, upload.organizationId),
        or(eq(organizationMembers.userId, user.userId), eq(organizationMembers.email, user.email)),
      ))
      .limit(1);
    if (!member) throw new ApiError("你沒有查看此照片的權限。", 403);
    if (!env.BUCKET) throw new ApiError("照片儲存服務尚未就緒。", 503);
    const object = await env.BUCKET.get(upload.r2Key);
    if (!object) throw new ApiError("找不到照片檔案。", 404);
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType || upload.contentType,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
