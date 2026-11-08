CREATE TABLE `band_hours` (
	`hour` integer NOT NULL,
	`band` text NOT NULL,
	`mode` text NOT NULL,
	`continent` text NOT NULL,
	`windows` integer DEFAULT 0 NOT NULL,
	`decodes` integer DEFAULT 0 NOT NULL,
	`stations` integer DEFAULT 0 NOT NULL,
	`best_snr` integer,
	PRIMARY KEY(`hour`, `band`, `mode`, `continent`)
);
--> statement-breakpoint
CREATE TABLE `heard_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`receiver` text NOT NULL,
	`grid` text,
	`freq_hz` integer NOT NULL,
	`band` text NOT NULL,
	`mode` text NOT NULL,
	`snr` integer,
	`distance_km` integer,
	`dxcc` integer,
	`continent` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `heard_reports_uq` ON `heard_reports` (`receiver`,`at`,`band`);--> statement-breakpoint
CREATE INDEX `heard_reports_at_idx` ON `heard_reports` (`at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`categories` text DEFAULT '["needed","faults","digest"]' NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_ok_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_endpoint_uq` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`started_by` text NOT NULL,
	`stop_reason` text,
	`modes` text DEFAULT '[]' NOT NULL,
	`bands` text DEFAULT '[]' NOT NULL,
	`qsos` integer DEFAULT 0 NOT NULL,
	`new_ones` text DEFAULT '[]' NOT NULL,
	`transmissions` integer DEFAULT 0 NOT NULL,
	`tx_seconds` integer DEFAULT 0 NOT NULL,
	`faults` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_started_idx` ON `runs` (`started_at`);