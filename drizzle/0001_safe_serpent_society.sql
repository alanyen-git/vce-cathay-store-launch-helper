CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`request_key` text NOT NULL,
	`asset_id` text NOT NULL,
	`asset_no` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_unique_request` ON `idempotency_keys` (`organization_id`,`actor_user_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_photos_unique_upload` ON `asset_photos` (`upload_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_photos_unique_asset_position` ON `asset_photos` (`asset_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchasing_units_unique_organization_label` ON `purchasing_units` (`organization_id`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `stores_unique_organization_code` ON `stores` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `uploads_staged_cleanup_index` ON `uploads` (`organization_id`,`uploader_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_units_unique_organization_label` ON `usage_units` (`organization_id`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_unique_organization_name` ON `vendors` (`organization_id`,`name`);