/**
 * Checks that the database is the one this build expects, and stops.
 *
 *   DATABASE_URL=postgres://... npm run db:verify
 *
 * Run after migrating and before the Worker goes out. Migrating reports what
 * it applied; this reports what is *there*, which is a different question and
 * the one that matters to the code about to serve traffic. It answers three:
 * is any migration still pending, has an applied file been edited since, and
 * does every table the store reads exist.
 *
 * It only reads, so it is safe to run against production at any time, and
 * running it twice says the same thing as running it once.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/*
 * The tables the Worker reads or writes. Kept here as a list rather than
 * derived from the migrations, so that dropping one in a later migration
 * without noticing what still selects from it fails here rather than in a
 * request.
 */
const REQUIRED_TABLES = [
  "account_activity",
  "account_keys",
  "agent_commands",
  "app_events",
  "audit_events",
  "auth_codes",
  "cli_tokens",
  "comments",
  "deleted_accounts",
  "external_analysis_consents",
  "feedback",
  /*
   * The game's two. The Worker serves /api/game, /api/game/runs and the
   * gathering from these, so a deploy that reached production without them
   * would verify clean and then fail on the first request to the keep.
   */
  "game_collection_runs",
  "game_profiles",
  "invites",
  "jev_assessments",
  "jev_budget",
  "memberships",
  "mcp_team_grants",
  "notifications",
  "organizations",
  "schema_migrations",
  "session_key_shares",
  "session_password_requests",
  "sessions",
  "team_key_shares",
  "team_keys",
];

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "lib", "migrations");
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("verify: set DATABASE_URL to the database to check");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
const problems: string[] = [];

try {
  const directory = migrationsDir();
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();

  const { rows } = await pool.query<{ name: string; checksum: string | null }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  for (const name of files) {
    const checksum = createHash("sha256").update(readFileSync(join(directory, name), "utf8")).digest("hex");
    if (!applied.has(name)) {
      problems.push(`${name} has not been applied`);
      continue;
    }
    const recorded = applied.get(name);
    /* Null is a row written before checksums; migrating fills it in. */
    if (recorded !== null && recorded !== checksum) {
      problems.push(`${name} differs from the file that was applied`);
    }
  }

  /* A database ahead of this build: an older deploy must not migrate it back. */
  for (const name of applied.keys()) {
    if (!files.includes(name)) problems.push(`${name} is applied but not in this build`);
  }

  const present = new Set(
    (
      await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).rows.map((row) => row.table_name),
  );
  for (const table of REQUIRED_TABLES) {
    if (!present.has(table)) problems.push(`table ${table} is missing`);
  }

  if (problems.length > 0) {
    console.error("verify: this database is not what this build expects");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`verify: schema is what this build expects (${files.length} migrations, ${REQUIRED_TABLES.length} tables).`);
  }
} catch (error) {
  console.error(`verify: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
