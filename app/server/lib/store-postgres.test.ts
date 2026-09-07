import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "./store-postgres";

/**
 * Migration bookkeeping, which the conformance suite cannot reach because it
 * only speaks the Store interface. Runs only against a real database.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;

const openPools: pg.Pool[] = [];

async function freshDatabase(name: string): Promise<string> {
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  openPools.push(admin);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  /* Same server, different database: swap the path of the connection string. */
  return DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

afterAll(async () => {
  await Promise.all(openPools.map((pool) => pool.end()));
});

describe.skipIf(!DATABASE_URL)("migrations", () => {
  it("applies the schema and records it once", async () => {
    const url = await freshDatabase("shell_online_migrate");
    const first = await PostgresStore.connect(url);
    await first.close();
    /* Connecting again must be a no-op, not a second application. */
    const second = await PostgresStore.connect(url);
    await second.close();

    const pool = new pg.Pool({ connectionString: url });
    openPools.push(pool);
    const rows = (await pool.query("SELECT name, checksum FROM schema_migrations")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to start when an applied migration has been edited", async () => {
    const url = await freshDatabase("shell_online_tampered");
    await (await PostgresStore.connect(url)).close();

    const pool = new pg.Pool({ connectionString: url });
    openPools.push(pool);
    await pool.query("UPDATE schema_migrations SET checksum = 'not-what-was-applied'");

    await expect(PostgresStore.connect(url)).rejects.toThrow(/changed after it was applied/);
  });

  /*
   * A database written before checksums existed has no such column, and
   * CREATE TABLE IF NOT EXISTS does not add one. This is the table that
   * records migrations, so no migration can repair it.
   */
  it("upgrades a bookkeeping table written before checksums existed", async () => {
    const url = await freshDatabase("shell_online_legacy");
    const pool = new pg.Pool({ connectionString: url });
    openPools.push(pool);
    await pool.query(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
    );
    await pool.query("INSERT INTO schema_migrations VALUES ('001_initial.sql', 1)");
    /* The tables that migration would have created, as that build left them. */
    await pool.query("CREATE TABLE organizations (id TEXT PRIMARY KEY)");

    const store = await PostgresStore.connect(url);
    await store.close();

    const rows = (await pool.query("SELECT checksum FROM schema_migrations")).rows;
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
