/**
 * Copies a file store into Postgres.
 *
 *   DATABASE_URL=postgres://... npx tsx server/import-json.ts [.data/accounts.json]
 *
 * It goes through the Store interface rather than writing SQL, so every record
 * takes the same path a live write does and lands under the same constraints.
 * Running it twice is safe for everything the interface upserts, and reports
 * what it skipped for everything it does not.
 */
import { resolve } from "node:path";
import { MemoryStore } from "./lib/store-memory";
import { PostgresStore } from "./lib/store-postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("import: set DATABASE_URL to the database to import into");
  process.exit(1);
}

const file = resolve(process.argv[2] ?? ".data/accounts.json");
const source = new MemoryStore(file);
const target = await PostgresStore.connect(url);

let copied = 0;
let skipped = 0;

/*
 * A record that is already there is not a failure: this is a copy, and the
 * only way to know an insert conflicted is to try it. The reason is printed
 * once per record so a genuine schema problem is not hidden among them.
 */
async function copy(what: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
    copied += 1;
  } catch (error) {
    skipped += 1;
    console.warn(`  skipped ${what}: ${(error as Error).message}`);
  }
}

/*
 * Organizations first, then memberships and invites that reference them: the
 * foreign keys mean the order is not a preference.
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

console.log(`import: ${copied} records copied from ${file}, ${skipped} skipped`);
await target.close();
