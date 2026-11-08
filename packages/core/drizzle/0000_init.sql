CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`role` text DEFAULT 'VIEWER' NOT NULL,
	`created_by_id` text,
	`active` integer DEFAULT true NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_uq` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `decodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`mode` text NOT NULL,
	`band` text NOT NULL,
	`dial_hz` integer NOT NULL,
	`audio_hz` integer NOT NULL,
	`snr` integer NOT NULL,
	`dt_ms` integer NOT NULL,
	`message` text NOT NULL,
	`callsign` text,
	`grid` text,
	`is_cq` integer DEFAULT false NOT NULL,
	`logged_qso_id` text,
	FOREIGN KEY (`logged_qso_id`) REFERENCES `qsos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `decodes_at_idx` ON `decodes` (`at`);--> statement-breakpoint
CREATE INDEX `decodes_band_at_idx` ON `decodes` (`band`,`at`);--> statement-breakpoint
CREATE INDEX `decodes_call_idx` ON `decodes` (`callsign`);--> statement-breakpoint
CREATE TABLE `do_not_call` (
	`callsign` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`note` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `engine_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `incomplete_exchanges` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`callsign` text NOT NULL,
	`band` text NOT NULL,
	`freq_hz` integer NOT NULL,
	`mode` text NOT NULL,
	`start_time` integer NOT NULL,
	`rst_sent` text,
	`rst_rcvd` text,
	`grid` text,
	`transcript` text,
	`reason` text NOT NULL,
	`resolved_at` integer,
	`promoted_qso_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`promoted_qso_id`) REFERENCES `qsos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `incomplete_unresolved_idx` ON `incomplete_exchanges` (`resolved_at`,`start_time`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operators` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`name` text NOT NULL,
	`callsign` text NOT NULL,
	`user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `operators_station_idx` ON `operators` (`station_id`);--> statement-breakpoint
CREATE TABLE `qsl_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`qso_id` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`approved_by_id` text,
	`sent_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`qso_id`) REFERENCES `qsos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `qsl_emails_status_idx` ON `qsl_emails` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `qsl_emails_qso_idx` ON `qsl_emails` (`qso_id`);--> statement-breakpoint
CREATE TABLE `qsl_opt_outs` (
	`target` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `qso_sig_refs` (
	`qso_id` text NOT NULL,
	`sig` text NOT NULL,
	`ref` text NOT NULL,
	PRIMARY KEY(`qso_id`, `sig`, `ref`),
	FOREIGN KEY (`qso_id`) REFERENCES `qsos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `qso_sig_refs_ref_idx` ON `qso_sig_refs` (`sig`,`ref`);--> statement-breakpoint
CREATE TABLE `qsos` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`operator_id` text,
	`client_id` text,
	`callsign` text NOT NULL,
	`band` text NOT NULL,
	`freq_hz` integer NOT NULL,
	`mode` text NOT NULL,
	`submode` text,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`rst_sent` text,
	`rst_rcvd` text,
	`tx_power_w` integer,
	`grid` text,
	`name` text,
	`qth` text,
	`dxcc` integer,
	`state` text,
	`county` text,
	`cq_zone` integer,
	`itu_zone` integer,
	`iota` text,
	`continent` text,
	`sig` text,
	`sig_info` text,
	`my_sig` text,
	`my_sig_info` text,
	`my_grid` text,
	`radio` text,
	`qsl_sent` text DEFAULT 'NONE' NOT NULL,
	`qsl_rcvd` text DEFAULT 'NONE' NOT NULL,
	`qsl_sent_at` integer,
	`qsl_rcvd_at` integer,
	`qsl_sent_via` text,
	`qsl_rcvd_via` text,
	`lotw_rcvd` integer DEFAULT false NOT NULL,
	`lotw_rcvd_at` integer,
	`eqsl_rcvd` integer DEFAULT false NOT NULL,
	`qrz_rcvd` integer DEFAULT false NOT NULL,
	`qrz_log_id` integer,
	`prop_mode` text,
	`sat_name` text,
	`email` text,
	`notes` text,
	`extras` text,
	`transcript` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_id`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qsos_client_id_uq` ON `qsos` (`client_id`);--> statement-breakpoint
CREATE INDEX `qsos_callsign_idx` ON `qsos` (`callsign`);--> statement-breakpoint
CREATE INDEX `qsos_start_idx` ON `qsos` (`start_time`);--> statement-breakpoint
CREATE INDEX `qsos_call_band_mode_idx` ON `qsos` (`callsign`,`band`,`mode`);--> statement-breakpoint
CREATE INDEX `qsos_band_mode_idx` ON `qsos` (`band`,`mode`);--> statement-breakpoint
CREATE INDEX `qsos_dxcc_idx` ON `qsos` (`dxcc`);--> statement-breakpoint
CREATE INDEX `qsos_grid_idx` ON `qsos` (`grid`);--> statement-breakpoint
CREATE INDEX `qsos_state_idx` ON `qsos` (`state`);--> statement-breakpoint
CREATE INDEX `qsos_sig_info_idx` ON `qsos` (`sig_info`);--> statement-breakpoint
CREATE INDEX `qsos_my_sig_info_idx` ON `qsos` (`my_sig_info`,`start_time`);--> statement-breakpoint
CREATE INDEX `qsos_station_idx` ON `qsos` (`station_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `stations` (
	`id` text PRIMARY KEY NOT NULL,
	`callsign` text NOT NULL,
	`grid` text NOT NULL,
	`name` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stations_callsign_idx` ON `stations` (`callsign`);--> statement-breakpoint
CREATE TABLE `upload_state` (
	`qso_id` text NOT NULL,
	`service` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`sent_at` integer,
	`last_error` text,
	`remote_id` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`qso_id`, `service`),
	FOREIGN KEY (`qso_id`) REFERENCES `qsos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upload_state_queue_idx` ON `upload_state` (`service`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`callsign` text,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'VIEWER' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);