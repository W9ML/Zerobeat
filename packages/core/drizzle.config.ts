import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/drizzle",
  dbCredentials: { url: process.env.ZEROBEAT_DB ?? "./data/zerobeat.db" },
  strict: true,
  verbose: true,
});
