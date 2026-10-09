import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "manager", "editor", "viewer"] })
      .notNull()
      .default("viewer"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("organization_members_unique_user").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const stores = sqliteTable(
  "stores",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    status: text("status", { enum: ["籌備中", "營運中", "停用"] })
      .notNull()
      .default("籌備中"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("stores_unique_organization_code").on(
      table.organizationId,
      table.code,
    ),
  ],
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  storeId: text("store_id"),
  name: text("name").notNull(),
  status: text("status", { enum: ["規劃中", "進行中", "已結案"] })
    .notNull()
    .default("規劃中"),
  ...timestamps,
});

export const assetCategories = sqliteTable(
  "asset_categories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    label: text("label").notNull(),
    prefix: text("prefix").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("asset_categories_unique_prefix").on(
      table.organizationId,
      table.prefix,
    ),
  ],
);

export const usageUnits = sqliteTable(
  "usage_units",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("usage_units_unique_organization_label").on(table.organizationId, table.label)],
);

export const purchasingUnits = sqliteTable(
  "purchasing_units",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("purchasing_units_unique_organization_label").on(table.organizationId, table.label)],
);

export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("vendors_unique_organization_name").on(table.organizationId, table.name)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    currentStoreId: text("current_store_id").notNull(),
    originProjectId: text("origin_project_id"),
    categoryId: text("category_id").notNull(),
    usageUnitId: text("usage_unit_id").notNull(),
    purchasingUnitId: text("purchasing_unit_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    assetNo: text("asset_no").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default(""),
    specification: text("specification").notNull().default(""),
    unitPrice: integer("unit_price").notNull(),
    status: text("status", {
      enum: ["已列管", "待盤點", "維修中", "報廢", "遺失", "封存"],
    })
      .notNull()
      .default("已列管"),
    notes: text("notes").notNull().default(""),
    purchaseDate: text("purchase_date"),
    warrantyEnd: text("warranty_end"),
    createdByUserId: text("created_by_user_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("assets_unique_organization_asset_no").on(
      table.organizationId,
      table.assetNo,
    ),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    requestKey: text("request_key").notNull(),
    assetId: text("asset_id").notNull(),
    assetNo: text("asset_no").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_unique_request").on(
      table.organizationId,
      table.actorUserId,
      table.requestKey,
    ),
  ],
);

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  uploaderUserId: text("uploader_user_id").notNull(),
  r2Key: text("r2_key").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  status: text("status", { enum: ["staged", "claimed"] })
    .notNull()
    .default("staged"),
  ...timestamps,
}, (table) => [
  index("uploads_staged_cleanup_index").on(table.organizationId, table.uploaderUserId, table.status, table.createdAt),
]);

export const assetPhotos = sqliteTable("asset_photos", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assetId: text("asset_id").notNull(),
  uploadId: text("upload_id").notNull(),
  r2Key: text("r2_key").notNull(),
  contentType: text("content_type").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("asset_photos_unique_upload").on(table.uploadId),
  uniqueIndex("asset_photos_unique_asset_position").on(table.assetId, table.position),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assetId: text("asset_id"),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: text("created_at").notNull(),
});
