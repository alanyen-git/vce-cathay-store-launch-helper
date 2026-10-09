import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { uploads } from "@/db/schema";
import { ApiError, errorResponse, requireOrganization } from "@/lib/server";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  try {
    const { uploadId } = await params;
    const context = await requireOrganization(new URL(request.url).searchParams.get("organizationId"));
    const db = getDb();
    const [upload] = await db
      .select()
      .from(uploads)
      .where(and(
        eq(uploads.id, uploadId),
        eq(uploads.organizationId, context.organizationId),
        eq(uploads.uploaderUserId, context.user.userId),
        eq(uploads.status, "staged"),
      ))
      .limit(1);
    if (!upload) throw new ApiError("找不到可取消的暫存照片。", 404);
    if (!env.BUCKET) throw new ApiError("照片儲存服務尚未就緒。", 503);
    await env.BUCKET.delete(upload.r2Key);
    await db.delete(uploads).where(eq(uploads.id, upload.id));
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
