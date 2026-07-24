CREATE TABLE `like_notification_receipts` (
	`actor_user_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`actor_user_id`, `recording_id`),
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `like_notification_receipts_recipient_idx` ON `like_notification_receipts` (`recipient_user_id`);--> statement-breakpoint
CREATE INDEX `like_notification_receipts_recording_idx` ON `like_notification_receipts` (`recording_id`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`fcm_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_fcm_token_uq` ON `push_devices` (`fcm_token`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
INSERT INTO `like_notification_receipts` (
	`actor_user_id`,
	`recipient_user_id`,
	`recording_id`,
	`created_at`
)
SELECT
	`likes`.`user_id`,
	`recordings`.`user_id`,
	`likes`.`recording_id`,
	`likes`.`created_at`
FROM `likes`
INNER JOIN `recordings` ON `recordings`.`id` = `likes`.`recording_id`
WHERE `likes`.`user_id` <> `recordings`.`user_id`;
