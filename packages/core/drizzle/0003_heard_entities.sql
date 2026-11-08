CREATE TABLE `heard_entities` (
	`dxcc` integer NOT NULL,
	`band` text NOT NULL,
	`mode` text NOT NULL,
	`hour_of_day` integer NOT NULL,
	`decodes` integer DEFAULT 0 NOT NULL,
	`days` integer DEFAULT 0 NOT NULL,
	`last_day` integer DEFAULT 0 NOT NULL,
	`best_snr` integer,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`last_call` text,
	PRIMARY KEY(`dxcc`, `band`, `mode`, `hour_of_day`)
);
