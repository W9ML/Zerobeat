/** Apply database migrations: npm run db:migrate */
import { openDb } from "../packages/core/src/db/client.ts";
import { runMigrations } from "../packages/core/src/db/migrate.ts";

const { db, sqlite } = openDb();
runMigrations(db);
sqlite.close();
console.log("migrations applied to", process.env.ZEROBEAT_DB ?? "./data/zerobeat.db");
