import { and, asc, eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  assetCategories,
  organizationMembers,
  organizations,
  projects,
  purchasingUnits,
  stores,
  usageUnits,
  vendors,
} from "@/db/schema";
import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";

export type MemberRole = "admin" | "manager" | "editor" | "viewer";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function now() {
  return new Date().toISOString();
}

export function newId() {
  return crypto.randomUUID();
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return Response.json({ error: "系統處理失敗，請稍後再試。" }, { status: 500 });
}

export async function requireUser(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (!user) throw new ApiError("請先登入後再使用開店小幫手。", 401);
  return user;
}

async function seedOrganization(user: ChatGPTUser) {
  const db = getDb();
  const organizationId = newId();
  const createdAt = now();
  const defaultStoreId = newId();
  const defaultProjectId = newId();

  const categories = [
    ["廚房設備", "KIT"],
    ["吧台設備", "BAR"],
    ["餐廳設備", "DIN"],
    ["家具", "FUR"],
    ["資訊設備", "IT"],
    ["其他固定資產", "OTH"],
  ];
  const statements = [
    db.insert(organizations).values({ id: organizationId, name: "我的公司", createdAt, updatedAt: createdAt }),
    db.insert(organizationMembers).values({ id: newId(), organizationId, userId: user.userId, email: user.email, displayName: user.displayName, role: "admin", createdAt, updatedAt: createdAt }),
    db.insert(stores).values({ id: defaultStoreId, organizationId, name: "中央倉庫／待進場", code: "WAREHOUSE", status: "籌備中", createdAt, updatedAt: createdAt }),
    db.insert(projects).values({ id: defaultProjectId, organizationId, storeId: defaultStoreId, name: "開店準備專案", status: "進行中", createdAt, updatedAt: createdAt }),
    ...categories.map(([label, prefix], index) => db.insert(assetCategories).values({
      id: newId(),
      organizationId,
      label,
      prefix,
      sortOrder: index + 1,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    })),
    ...[
    "廚房",
    "吧台",
    "外場",
    "倉庫",
    "辦公區",
    "中央倉庫／待進場",
    ].map((label, index) => db.insert(usageUnits).values({
      id: newId(),
      organizationId,
      label,
      sortOrder: index + 1,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    })),
    ...[
    "總公司採購",
    "門市自購",
    "工程統包商",
    "品牌總部",
    "其他",
    ].map((label, index) => db.insert(purchasingUnits).values({
      id: newId(),
      organizationId,
      label,
      sortOrder: index + 1,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    })),
    ...["待確認", "宏盛餐飲設備", "新源冷凍工程", "品味家具", "雲端資訊科技"].map((label) => db.insert(vendors).values({
      id: newId(),
      organizationId,
      name: label,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    })),
  ] as const;
  await db.batch(statements);
  return organizationId;
}

export async function requireOrganization(organizationId?: string | null) {
  const user = await requireUser();
  const db = getDb();
  const memberships = await db
    .select({
      organizationId: organizationMembers.organizationId,
      role: organizationMembers.role,
      name: organizations.name,
      memberUserId: organizationMembers.userId,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(or(eq(organizationMembers.userId, user.userId), eq(organizationMembers.email, user.email)))
    .orderBy(asc(organizations.createdAt));

  let selected = memberships.find((member) => member.organizationId === organizationId) ?? memberships[0];
  if (!selected) {
    const id = await seedOrganization(user);
    selected = {
      organizationId: id,
      role: "admin",
      name: "我的公司",
      memberUserId: user.userId,
    };
  }
  if (organizationId && selected.organizationId !== organizationId) {
    throw new ApiError("你沒有這家公司的存取權限。", 403);
  }
  return {
    user: { ...user, userId: selected.memberUserId },
    organizationId: selected.organizationId,
    organizationName: selected.name,
    role: selected.role as MemberRole,
  };
}

export function assertRole(role: MemberRole, allowed: MemberRole[]) {
  if (!allowed.includes(role)) throw new ApiError("你的權限不足，無法執行此操作。", 403);
}

export async function getMasterData(organizationId: string) {
  const db = getDb();
  const [categoryRows, usageRows, purchasingRows, vendorRows, storeRows, projectRows] = await Promise.all([
    db.select().from(assetCategories).where(and(eq(assetCategories.organizationId, organizationId), eq(assetCategories.isActive, true))).orderBy(asc(assetCategories.sortOrder)),
    db.select().from(usageUnits).where(and(eq(usageUnits.organizationId, organizationId), eq(usageUnits.isActive, true))).orderBy(asc(usageUnits.sortOrder)),
    db.select().from(purchasingUnits).where(and(eq(purchasingUnits.organizationId, organizationId), eq(purchasingUnits.isActive, true))).orderBy(asc(purchasingUnits.sortOrder)),
    db.select().from(vendors).where(and(eq(vendors.organizationId, organizationId), eq(vendors.isActive, true))).orderBy(asc(vendors.name)),
    db.select().from(stores).where(eq(stores.organizationId, organizationId)).orderBy(asc(stores.createdAt)),
    db.select().from(projects).where(eq(projects.organizationId, organizationId)).orderBy(asc(projects.createdAt)),
  ]);
  return {
    categories: categoryRows,
    usageUnits: usageRows,
    purchasingUnits: purchasingRows,
    vendors: vendorRows,
    stores: storeRows,
    projects: projectRows,
  };
}

export function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
