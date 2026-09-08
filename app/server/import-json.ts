/**
 * Copies a file store into Postgres.
 *
 *   DATABASE_URL=postgres://... npx tsx server/import-json.ts [.data/accounts.json]
 *
 * It goes through the Store interface rather than writing SQL, so every record
 * takes the same path a live write does and lands under the same constraints.
 * Running it twice is safe: stores upsert the records they can and duplicate
 * primary/unique keys are the only writes this importer is allowed to skip.
 * Every other error fails the import and gives the operator a non-zero exit.
 */
import { resolve } from "node:path";
import { MemoryStore } from "./lib/store-memory";
import { PostgresStore } from "./lib/store-postgres";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  console.error("import: set DATABASE_URL to the database to import into");
  process.exit(1);
}

const file = resolve(process.argv[2] ?? ".data/accounts.json");
type DatabaseError = Error & { code?: string };

/** PostgreSQL 23505 is the one expected idempotency conflict. */
function isDuplicate(error: unknown): error is DatabaseError {
  return error instanceof Error && (error as DatabaseError).code === "23505";
}

async function main(): Promise<void> {
  const source = new MemoryStore(file);
  const target = await PostgresStore.connect(databaseUrl);
  let copied = 0;
  let skipped = 0;

  /*
   * A record already present is not a failure. Connection, schema, foreign-key
   * and programming errors are: allowing one through would make a partial
   * migration look successful.
   */
  async function copy(what: string, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
      copied += 1;
    } catch (error) {
      if (!isDuplicate(error)) {
        throw new Error(`could not copy ${what}: ${(error as Error).message}`, { cause: error });
      }
      skipped += 1;
      console.warn(`  already present: ${what}`);
    }
  }

  try {
    /*
     * Organizations first, then memberships and invites that reference them:
     * the foreign keys mean the order is not a preference.
     */
    const organizations = await source.organizationsForImport();
    for (const organization of organizations) {
      await copy(`organization ${organization.id}`, () => target.putOrganization(organization));
    }

    for (const organization of organizations) {
      for (const membership of await source.members(organization.id)) {
        await copy(`membership ${membership.uid}`, () => target.putMembership(membership));
      }
      for (const invite of await source.invites(organization.id)) {
        await copy(`invite ${invite.id}`, () => target.putInvite(invite));
      }
      for (const event of await source.auditForOrg(organization.id, Number.MAX_SAFE_INTEGER)) {
        await copy(`audit ${event.id}`, () => target.putAudit(event));
      }
    }

    for (const token of await source.tokensForImport()) {
      await copy(`device ${token.id}`, () => target.putToken(token));
    }

    for (const session of await source.sessionsForImport()) {
      await copy(`session ${session.id}`, () => target.upsertSession(session));
    }

    for (const comment of await source.commentsForImport()) {
      await copy(`comment ${comment.id}`, () => target.putComment(comment));
    }

    for (const notification of await source.notificationsForImport()) {
      await copy(`notification ${notification.id}`, () => target.putNotification(notification));
    }

    console.log(`import: ${copied} records copied from ${file}, ${skipped} already present`);
  } finally {
    await target.close();
  }
}

main().catch((error) => {
  console.error(`import: failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
