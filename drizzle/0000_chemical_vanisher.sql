CREATE TABLE `likes` (
	`user_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `recording_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `likes_recording_idx` ON `likes` (`recording_id`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`description` text,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`address` text,
	`geohash` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`format` text NOT NULL,
	`file_size_bytes` integer DEFAULT 0 NOT NULL,
	`audio_key` text NOT NULL,
	`image_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`report_count` integer DEFAULT 0 NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`recorded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_audio_key_unique` ON `recordings` (`audio_key`);--> statement-breakpoint
CREATE INDEX `recordings_public_location_idx` ON `recordings` (`latitude`,`longitude`) WHERE status = 'ready' AND visibility = 'public';--> statement-breakpoint
CREATE INDEX `recordings_public_score_idx` ON `recordings` (`score`) WHERE status = 'ready' AND visibility = 'public';--> statement-breakpoint
CREATE INDEX `recordings_geohash_idx` ON `recordings` (`geohash`);--> statement-breakpoint
CREATE INDEX `recordings_user_created_idx` ON `recordings` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`reporter_user_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_recording_reporter_uq` ON `reports` (`recording_id`,`reporter_user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`banned_at` integer
);
