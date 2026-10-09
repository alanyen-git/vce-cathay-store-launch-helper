import { stores } from "@/db/schema";
import { assertRole, cleanText, errorResponse, newId, now, requireOrganization } from "@/lib/server";
import { getDb } from "@/db";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as {
      organizationId?: string;
      name?: string;
      code?: string;
      status?: string;
    };
    const context = await requireOrganization(payload.organizationId);
    assertRole(context.role, ["admin", "manager"]);
    const name = cleanText(payload.name, 60);
    const code = cleanText(payload.code, 16).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!name || !code) return Response.json({ error: "請填寫門市名稱與代碼。" }, { status: 400 });
    const timestamp = now();
    const store = {
      id: newId(),
      organizationId: context.organizationId,
      name,
      code,
      status: payload.status === "營運中" ? "營運中" as const : "籌備中" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await getDb().insert(stores).values(store);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        return Response.json({ error: "此公司已使用相同的門市代碼。" }, { status: 409 });
      }
      throw error;
    }
    return Response.json({ store }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
