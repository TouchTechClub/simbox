CREATE TABLE `runner_settings` (
	`user_id` text PRIMARY KEY,
	`ios_runner` text,
	`android_runner` text,
	CONSTRAINT `fk_runner_settings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `repos` ADD `ios_runner` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `android_runner` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `runner` text;