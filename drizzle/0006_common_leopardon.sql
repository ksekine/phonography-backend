DROP INDEX `recordings_user_created_idx`;--> statement-breakpoint
CREATE INDEX `recordings_user_created_idx` ON `recordings` (`user_id`,`created_at`,`id`);