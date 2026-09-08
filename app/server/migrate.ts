/**
 * Applies pending migrations, then stops.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 *
 * A deliberate step rather than something the service does on the way up. The
 * service runs on Workers, where an isolate starts per request and dozens of
 * them would race the same DDL on a cold deploy; and a schema change is a
 * thing an operator should choose to run and watch, not discover in a log.
 *
 * Safe to run repeatedly. Each file is applied once and its checksum recorded,
 * so a second run does nothing and an edited file is refused.
 */
import { PostgresStore } from "./lib/store-postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: set DATABASE_URL to the database to migrate");
  process.exit(1);
}

/* One connection: this runs alone and holds an advisory lock while it works. */
const store = await PostgresStore.connect(url, { migrate: false, max: 1 });
try {
  await store.migrateNow();
  console.log("migrate: schema is up to date");
} catch (error) {
  console.error(`migrate: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
