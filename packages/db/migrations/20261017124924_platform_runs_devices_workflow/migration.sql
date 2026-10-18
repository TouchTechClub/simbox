ALTER TABLE `repos` ADD `ios_device` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `android_device` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `workflow` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runner_settings` ADD `ios_device` text;--> statement-breakpoint
ALTER TABLE `runner_settings` ADD `android_device` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `booted_device` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `devices_ready` integer;--> statement-breakpoint
-- Before the one-active-run-per-platform index: end all but the newest active
-- run per user and platform (a single active run per user was enforced only by
-- application logic until now).
UPDATE `runs` SET `state` = 'ended', `end_reason` = 'superseded', `ended_at` = coalesce(`ended_at`, `created_at`)
WHERE `state` in ('dispatching', 'queued', 'booting', 'live')
  AND `id` NOT IN (
    SELECT `id` FROM (
      SELECT `id`, row_number() OVER (PARTITION BY `user_id`, `platform` ORDER BY `created_at` DESC) AS `rank`
      FROM `runs` WHERE `state` in ('dispatching', 'queued', 'booting', 'live')
    ) WHERE `rank` = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runs_active_platform` ON `runs` (`user_id`,`platform`) WHERE "runs"."state" in ('dispatching', 'queued', 'booting', 'live');