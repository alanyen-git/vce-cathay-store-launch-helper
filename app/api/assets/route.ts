import { getDb } from "@/db";
import {
  assetCategories,
  assetPhotos,
  assets,
  auditLogs,
  idempotencyKeys,
  stores,
  uploads,
  usageUnits,
  vendors,
} from "@/db/schema";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import {
  ApiError,
  assertRole,
  cleanText,
  errorResponse,
  getMasterData,
  newId,
  now,
  requireOrganization,
} from "@/lib/server";

const ASSET_STATUSES = ["已列管", "待盤點", "維修中", "報廢", "遺失", "封存"] as const;
type AssetStatus = (typeof ASSET_STATUSES)[number];

type AssetPayload = {
  organizationId?: string;
  currentStoreId?: string;
  originProjectId?: string | null;
  categoryId?: string;
  usageUnitId?: string;
  purchasingUnitId?: string;
  vendorId?: string;
  name?: string;
  color?: string;
  specification?: string;
  unitPrice?: number;
  purchaseDate?: string;
  warrantyEnd?: string;
  notes?: string;
  uploadIds?: string[];
  requestedAssetNo?: string;
  importStatus?: AssetStatus;
};

export async function GET(request: Request) {
  try {
    const context = await requireOrganization(new URL(request.url).searchParams.get("organizationId"));
    const db = getDb();
    const rows = await db
      .select({
        id: assets.id,
        assetNo: assets.assetNo,
        name: assets.name,
        unitPrice: assets.unitPrice,
        status: assets.status,
        createdAt: assets.createdAt,
        category: assetCategories.label,
        usageUnit: usageUnits.label,
        storeName: stores.name,
        vendorName: vendors.name,
      })
      .from(assets)
      .innerJoin(assetCategories, eq(assets.categoryId, assetCategories.id))
      .innerJoin(usageUnits, eq(assets.usageUnitId, usageUnits.id))
      .innerJoin(stores, eq(assets.currentStoreId, stores.id))
      .innerJoin(vendors, eq(assets.vendorId, vendors.id))
      .where(eq(assets.organizationId, context.organizationId))
      .orderBy(asc(assetCategories.sortOrder), asc(assets.assetNo));
    const photoRows = await db
      .select({ assetId: assetPhotos.assetId, uploadId: assetPhotos.uploadId })
      .from(assetPhotos)
      .where(and(eq(assetPhotos.organizationId, context.organizationId), eq(assetPhotos.isPrimary, true)))
      .orderBy(asc(assetPhotos.position));
    const primaryByAsset = new Map<string, string>();
    for (const photo of photoRows) {
      if (!primaryByAsset.has(photo.assetId)) primaryByAsset.set(photo.assetId, photo.uploadId);
    }
    return Response.json({
      assets: rows.map((row) => ({
        ...row,
        primaryPhotoUrl: primaryByAsset.get(row.id)
          ? `/api/photos/${primaryByAsset.get(row.id)}`
          : null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as AssetPayload;
    const context = await requireOrganization(payload.organizationId);
    assertRole(context.role, ["admin", "manager", "editor"]);
    const requestKey = readIdempotencyKey(request);
    const db = getDb();

    const [previous] = await db
      .select({ assetId: idempotencyKeys.assetId, assetNo: idempotencyKeys.assetNo })
      .from(idempotencyKeys)
      .where(and(
        eq(idempotencyKeys.organizationId, context.organizationId),
        eq(idempotencyKeys.actorUserId, context.user.userId),
        eq(idempotencyKeys.requestKey, requestKey),
      ))
      .limit(1);
    if (previous) return Response.json({ asset: { id: previous.assetId, assetNo: previous.assetNo }, replayed: true });

    const input = validatePayload(payload);
    const isManager = context.role === "admin" || context.role === "manager";
    if ((input.requestedAssetNo || input.importStatus) && !isManager) {
      throw new ApiError("只有管理者可保留舊資料編號或狀態。", 403);
    }

    const master = await getMasterData(context.organizationId);
    const category = master.categories.find((row) => row.id === input.categoryId);
    const selectedStore = master.stores.find((row) => row.id === input.currentStoreId);
    const selectedProject = input.originProjectId
      ? master.projects.find((row) => row.id === input.originProjectId)
      : undefined;
    if (!category) throw new ApiError("請選擇有效的資產分類。");
    if (!selectedStore || selectedStore.status === "停用") throw new ApiError("請選擇有效且啟用中的目前門市。");
    if (!master.usageUnits.some((row) => row.id === input.usageUnitId)) throw new ApiError("請選擇有效的使用單位。");
    if (!master.purchasingUnits.some((row) => row.id === input.purchasingUnitId)) throw new ApiError("請選擇有效的採購單位。");
    if (!master.vendors.some((row) => row.id === input.vendorId)) throw new ApiError("請選擇有效的提供廠商。");
    if (input.originProjectId && !selectedProject) throw new ApiError("找不到來源專案。");
    if (selectedProject?.storeId && selectedProject.storeId !== input.currentStoreId) {
      throw new ApiError("來源專案必須隸屬於目前門市，請先確認資產所在地。");
    }

    const uploadRows = await db
      .select()
      .from(uploads)
      .where(inArray(uploads.id, input.uploadIds));
    if (
      uploadRows.length !== input.uploadIds.length ||
      uploadRows.some(
        (upload) =>
          upload.organizationId !== context.organizationId ||
          upload.uploaderUserId !== context.user.userId ||
          upload.status !== "staged",
      )
    ) {
      throw new ApiError("照片上傳已失效，請重新選擇照片。", 409);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const assetNo = input.requestedAssetNo || await nextAssetNo(context.organizationId, category.prefix);
      if (!new RegExp(`^${escapeRegExp(category.prefix)}-\\d{3,4}$`).test(assetNo)) {
        throw new ApiError("匯入的資產編號與所選分類不符。");
      }
      const timestamp = now();
      const assetId = newId();
      try {
        await db.batch([
          db.insert(assets).values({
            id: assetId,
            organizationId: context.organizationId,
            currentStoreId: input.currentStoreId,
            originProjectId: input.originProjectId || null,
            categoryId: input.categoryId,
            usageUnitId: input.usageUnitId,
            purchasingUnitId: input.purchasingUnitId,
            vendorId: input.vendorId,
            assetNo,
            name: input.name,
            color: input.color,
            specification: input.specification,
            unitPrice: input.unitPrice,
            purchaseDate: input.purchaseDate || null,
            warrantyEnd: input.warrantyEnd || null,
            notes: input.notes,
            status: input.importStatus || "已列管",
            createdByUserId: context.user.userId,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
          ...uploadRows.flatMap((upload, position) => [
            db.insert(assetPhotos).values({
              id: newId(),
              organizationId: context.organizationId,
              assetId,
              uploadId: upload.id,
              r2Key: upload.r2Key,
              contentType: upload.contentType,
              isPrimary: position === 0,
              position,
              createdAt: timestamp,
            }),
            db.update(uploads)
              .set({ status: "claimed", updatedAt: timestamp })
              .where(and(eq(uploads.id, upload.id), eq(uploads.status, "staged"))),
          ]),
          db.insert(auditLogs).values({
            id: newId(),
            organizationId: context.organizationId,
            assetId,
            actorUserId: context.user.userId,
            action: input.importStatus ? "asset_imported" : "asset_created",
            detail: `${input.importStatus ? "匯入" : "建立"}固定資產 ${assetNo}`,
            createdAt: timestamp,
          }),
          db.insert(idempotencyKeys).values({
            id: newId(),
            organizationId: context.organizationId,
            actorUserId: context.user.userId,
            requestKey,
            assetId,
            assetNo,
            createdAt: timestamp,
          }),
        ]);
        return Response.json({ asset: { id: assetId, assetNo } }, { status: 201 });
      } catch (error) {
        const [replayed] = await db
          .select({ assetId: idempotencyKeys.assetId, assetNo: idempotencyKeys.assetNo })
          .from(idempotencyKeys)
          .where(and(
            eq(idempotencyKeys.organizationId, context.organizationId),
            eq(idempotencyKeys.actorUserId, context.user.userId),
            eq(idempotencyKeys.requestKey, requestKey),
          ))
          .limit(1);
        if (replayed) return Response.json({ asset: { id: replayed.assetId, assetNo: replayed.assetNo }, replayed: true });
        if (input.requestedAssetNo || !isUniqueError(error) || attempt === 2) {
          throw isUniqueError(error)
            ? new ApiError("資產編號或照片剛被其他操作使用，請重新確認後再試。", 409)
            : error;
        }
      }
    }
    throw new ApiError("無法取得可用資產編號，請稍後再試。", 409);
  } catch (error) {
    return errorResponse(error);
  }
}

function validatePayload(payload: AssetPayload) {
  const uploadIds = Array.isArray(payload.uploadIds)
    ? [...new Set(payload.uploadIds.filter((id): id is string => typeof id === "string" && id.length <= 80))]
    : [];
  const input = {
    currentStoreId: cleanText(payload.currentStoreId, 80),
    originProjectId: cleanText(payload.originProjectId, 80),
    categoryId: cleanText(payload.categoryId, 80),
    usageUnitId: cleanText(payload.usageUnitId, 80),
    purchasingUnitId: cleanText(payload.purchasingUnitId, 80),
    vendorId: cleanText(payload.vendorId, 80),
    name: cleanText(payload.name, 80),
    color: cleanText(payload.color, 40),
    specification: cleanText(payload.specification, 300),
    unitPrice: Number(payload.unitPrice),
    purchaseDate: cleanText(payload.purchaseDate, 10),
    warrantyEnd: cleanText(payload.warrantyEnd, 10),
    notes: cleanText(payload.notes, 400),
    requestedAssetNo: cleanText(payload.requestedAssetNo, 20),
    importStatus: ASSET_STATUSES.includes(payload.importStatus as AssetStatus)
      ? payload.importStatus as AssetStatus
      : undefined,
    uploadIds,
  };
  const missing = [
    !input.currentStoreId && "目前門市",
    !input.categoryId && "資產分類",
    !input.usageUnitId && "使用單位",
    !input.name && "資產名稱",
    !input.purchasingUnitId && "採購單位",
    !input.vendorId && "提供廠商",
    !Number.isSafeInteger(input.unitPrice) || input.unitPrice <= 0 || input.unitPrice > 9_999_999_999 ? "單價（含稅）" : "",
    !input.uploadIds.length && "主照片",
  ].filter(Boolean);
  if (missing.length) throw new ApiError(`請補齊：${missing.join("、")}`);
  if (input.uploadIds.length > 6) throw new ApiError("每筆資產最多可上傳 6 張照片。");
  if (!isIsoDateOrEmpty(input.purchaseDate) || !isIsoDateOrEmpty(input.warrantyEnd)) {
    throw new ApiError("日期格式不正確。");
  }
  if (input.purchaseDate && input.warrantyEnd && input.warrantyEnd < input.purchaseDate) {
    throw new ApiError("保固到期日不可早於購買日期。");
  }
  return input;
}

function readIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim() || "";
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new ApiError("缺少有效的建檔識別碼，請重新開啟表單後再送出。", 400);
  }
  return key;
}

function isIsoDateOrEmpty(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUniqueError(error: unknown) {
  return String(error).toLowerCase().includes("unique");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function nextAssetNo(organizationId: string, prefix: string) {
  const rows = await getDb()
    .select({ assetNo: assets.assetNo })
    .from(assets)
    .where(and(eq(assets.organizationId, organizationId), like(assets.assetNo, `${prefix}-%`)));
  const used = new Set(rows.map((row) => row.assetNo));
  for (let number = 1; number <= 9999; number += 1) {
    const assetNo = `${prefix}-${String(number).padStart(3, "0")}`;
    if (!used.has(assetNo)) return assetNo;
  }
  throw new ApiError("此分類的可用資產編號已用完。", 409);
}
