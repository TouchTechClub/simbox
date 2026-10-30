CREATE TABLE `run_holders` (
	`run_id` text NOT NULL,
	`holder` text NOT NULL,
	`seen_at` integer NOT NULL,
	CONSTRAINT `run_holders_pk` PRIMARY KEY(`run_id`, `holder`),
	CONSTRAINT `fk_run_holders_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `max_devices` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `holder` text;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_runs_active_platform`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runs_starting_holder` ON `runs` (`user_id`,`platform`,`holder`) WHERE "runs"."state" in ('dispatching', 'queued', 'booting');