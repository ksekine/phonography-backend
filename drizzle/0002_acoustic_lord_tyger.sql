CREATE TABLE `recording_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`audio_key` text NOT NULL,
	`image_key` text,
	`title` text,
	`description` text,
	`latitude` real,
	`longitude` real,
	`address` text,
	`geohash` text,
	`duration_seconds` real NOT NULL,
	`format` text NOT NULL,
	`loudness_lufs` real,
	`true_peak_db` real,
	`recorded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_upload_sessions_audio_key_unique` ON `recording_upload_sessions` (`audio_key`);--> statement-breakpoint
CREATE INDEX `recording_upload_sessions_recording_idx` ON `recording_upload_sessions` (`recording_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`description` text,
	`latitude` real,
	`longitude` real,
	`address` text,
	`geohash` text,
	`duration_seconds` real NOT NULL,
	`format` text NOT NULL,
	`loudness_lufs` real,
	`true_peak_db` real,
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
INSERT INTO `__new_recordings`("id", "user_id", "title", "description", "latitude", "longitude", "address", "geohash", "duration_seconds", "format", "loudness_lufs", "true_peak_db", "file_size_bytes", "audio_key", "image_key", "status", "visibility", "like_count", "play_count", "download_count", "report_count", "score", "recorded_at", "created_at", "updated_at") SELECT "id", "user_id", "title", "description", "latitude", "longitude", "address", "geohash", "duration_seconds", "format", "loudness_lufs", "true_peak_db", "file_size_bytes", "audio_key", "image_key", "status", "visibility", "like_count", "play_count", "download_count", "report_count", "score", "recorded_at", "created_at", "updated_at" FROM `recordings`;--> statement-breakpoint
DROP TABLE `recordings`;--> statement-breakpoint
ALTER TABLE `__new_recordings` RENAME TO `recordings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_audio_key_unique` ON `recordings` (`audio_key`);--> statement-breakpoint
CREATE INDEX `recordings_public_location_idx` ON `recordings` (`latitude`,`longitude`) WHERE status = 'ready' AND visibility = 'public';--> statement-breakpoint
CREATE INDEX `recordings_public_score_idx` ON `recordings` (`score`) WHERE status = 'ready' AND visibility = 'public';--> statement-breakpoint
CREATE INDEX `recordings_geohash_idx` ON `recordings` (`geohash`);--> statement-breakpoint
CREATE INDEX `recordings_user_created_idx` ON `recordings` (`user_id`,`created_at`);