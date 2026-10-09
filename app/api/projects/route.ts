import { projects, stores } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { assertRole, cleanText, errorResponse, newId, now, requireOrganization } from "@/lib/server";
import { getDb } from "@/db";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as {
      organizationId?: string;
      name?: string;
      storeId?: string;
    };
    const context = await requireOrganization(payload.organizationId);
    assertRole(context.role, ["admin", "manager"]);
    const name = cleanText(payload.name, 80);
    const storeId = cleanText(payload.storeId, 80);
    if (!name || !storeId) return Response.json({ error: "請選擇門市並填寫專案名稱。" }, { status: 400 });
    const [store] = await getDb().select().from(stores).where(and(eq(stores.id, storeId), eq(stores.organizationId, context.organizationId))).limit(1);
    if (!store) return Response.json({ error: "找不到所選門市。" }, { status: 400 });
    const timestamp = now();
    const project = {
      id: newId(),
      organizationId: context.organizationId,
      storeId,
      name,
      status: "規劃中" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await getDb().insert(projects).values(project);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
