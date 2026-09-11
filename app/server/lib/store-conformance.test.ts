import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store-memory";
import { PostgresStore } from "./store-postgres";
import { DELETED_ACCOUNT_MEMORY_MS, DELETED_ACTOR_EMAIL, type Store } from "./store";
import type { AgentCommand, AuditEvent, CliToken, Notification, SessionRecord } from "./types";
import type { Invite, Membership, Organization } from "./orgs";

/**
 * One suite, run against every implementation of the interface.
 *
 * The tests the routes rely on are behavioural, not structural: that a claimed
 * command is not handed out twice, that a handoff survives a re-register, that
 * a device list is scoped to its account. Writing them once and running them
 * against both stores is what makes the in-memory one a fair stand-in during
 * development -- a difference in Postgres shows up here rather than in
 * production.
 *
 * Postgres runs only when TEST_DATABASE_URL points somewhere, so the suite
 * stays runnable without a database:
 *
 *   docker run -d -e POSTGRES_PASSWORD=dev -p 5433:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres npm test
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;

function token(overrides: Partial<CliToken> = {}): CliToken {
  return {
    id: "dev_1",
    accessHash: "access-hash",
    refreshHash: "refresh-hash",
    uid: "uid-1",
    email: "ana@example.com",
    name: "Ana Ruiz",
    label: "laptop",
    accessExpiresAt: 2000,
    createdAt: 1000,
    lastSeenAt: 1000,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    uid: "uid-1",
    orgId: "org_1",
    ownerUid: "uid-1",
    assigneeUid: "uid-1",
    shareUrl: "https://shell.online/s/s1",
    command: "htop",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "laptop",
    startedAt: 1000,
    ...overrides,
  };
}

function organization(overrides: Partial<Organization> = {}): Organization {
  return { id: "org_1", name: "Vulture", createdAt: 1000, createdBy: "uid-1", ...overrides };
}

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    orgId: "org_1",
    uid: "uid-1",
    email: "ana@example.com",
    name: "Ana Ruiz",
    role: "owner",
    joinedAt: 1000,
    ...overrides,
  };
}

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: "inv_1",
    orgId: "org_1",
    createdBy: "uid-1",
    role: "member",
    createdAt: 1000,
    expiresAt: 9000,
    ...overrides,
  };
}

function command(overrides: Partial<AgentCommand> = {}): AgentCommand {
  return {
    id: "cmd_1",
    uid: "uid-1",
    deviceId: "dev_1",
    kind: "start",
    command: "htop",
    createdAt: 1000,
    ...overrides,
  };
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "aud_1",
    orgId: "org_1",
    sessionId: "s1",
    at: 1000,
    actorUid: "uid-1",
    actorEmail: "ana@example.com",
    kind: "input",
    text: "ls -la",
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "ntf_1",
    orgId: "org_1",
    uid: "uid-2",
    kind: "mention",
    sessionId: "s1",
    actorUid: "uid-1",
    body: "take a look",
    at: 1000,
    ...overrides,
  };
}

type Implementation = { name: string; open: () => Promise<Store>; reset: (store: Store) => Promise<void> };

const TABLES = [
  "deleted_accounts",
  "account_keys",
  "session_key_shares",
  "sessions",
  "agent_commands",
  "audit_events",
  "comments",
  "notifications",
  "invites",
  "memberships",
  "organizations",
  "cli_tokens",
  "auth_codes",
];

const implementations: Implementation[] = [
  {
    name: "MemoryStore",
    open: async () => new MemoryStore(null),
    reset: async () => {},
  },
];

if (DATABASE_URL) {
  let shared: PostgresStore | null = null;
  implementations.push({
    name: "PostgresStore",
    open: async () => {
      shared ??= await PostgresStore.connect(DATABASE_URL);
      return shared;
    },
    reset: async (store) => {
      /* Reaching past the interface is the point: only a test truncates. */
      const pool = (store as unknown as { pool: { query: (text: string) => Promise<unknown> } }).pool;
      await pool.query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
    },
  });
  afterAll(async () => {
    await shared?.close();
  });
} else {
  /*
   * Silence rather than a skipped test, because a skipped test in CI looks
   * like a gap. The npm script that runs against a database says so.
   */
  console.warn("store conformance: TEST_DATABASE_URL not set, Postgres not exercised");
}

for (const implementation of implementations) {
  describe(implementation.name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await implementation.open();
      await implementation.reset(store);
    });

    describe("authorization codes", () => {
      const code = {
        code: "shc_1",
        uid: "uid-1",
        email: "ana@example.com",
        name: "Ana Ruiz",
        codeChallenge: "challenge",
        redirectUri: "http://127.0.0.1:41234/callback",
        expiresAt: 9000,
      };

      it("hands back the entry and marks it consumed", async () => {
        await store.putCode(code);
        const first = await store.takeCode("shc_1", 2000);
        expect(first?.alreadyConsumed).toBe(false);
        expect(first?.entry.uid).toBe("uid-1");
        expect(first?.entry.redirectUri).toBe(code.redirectUri);
      });

      it("reports a replay rather than handing the code out twice", async () => {
        await store.putCode(code);
        await store.takeCode("shc_1", 2000);
        const second = await store.takeCode("shc_1", 2001);
        expect(second?.alreadyConsumed).toBe(true);
      });

      it("returns null for a code it never issued", async () => {
        expect(await store.takeCode("shc_nope")).toBeNull();
      });

      it("drops expired codes when purging", async () => {
        await store.putCode(code);
        await store.purgeExpired(9001);
        expect(await store.takeCode("shc_1")).toBeNull();
      });
    });

    describe("devices", () => {
      it("finds a token by either hash", async () => {
        await store.putToken(token());
        expect((await store.findByAccessHash("access-hash"))?.id).toBe("dev_1");
        expect((await store.findByRefreshHash("refresh-hash"))?.id).toBe("dev_1");
        expect(await store.findByAccessHash("nope")).toBeNull();
      });

      it("applies a patch by refresh hash", async () => {
        await store.putToken(token());
        await store.updateToken("refresh-hash", { accessHash: "rotated", accessExpiresAt: 5000 });
        expect(await store.findByAccessHash("access-hash")).toBeNull();
        expect((await store.findByAccessHash("rotated"))?.accessExpiresAt).toBe(5000);
      });

      it("lists only this account's live machines, newest first", async () => {
        await store.putToken(token());
        await store.putToken(token({ id: "dev_2", accessHash: "a2", refreshHash: "r2", createdAt: 3000 }));
        await store.putToken(token({ id: "dev_3", accessHash: "a3", refreshHash: "r3", uid: "uid-2" }));
        expect((await store.listDevices("uid-1")).map((device) => device.id)).toEqual(["dev_2", "dev_1"]);
      });

      it("hides a revoked machine and refuses to revoke another account's", async () => {
        await store.putToken(token());
        expect(await store.revokeDevice("uid-2", "dev_1", 4000)).toBe(false);
        expect(await store.revokeDevice("uid-1", "dev_1", 4000)).toBe(true);
        expect(await store.listDevices("uid-1")).toEqual([]);
        /* A second revoke is not news. */
        expect(await store.revokeDevice("uid-1", "dev_1", 5000)).toBe(false);
      });

      it("holds lastSeenAt still within the resolution window", async () => {
        await store.putToken(token());
        await store.touchToken("dev_1", 30_000);
        expect((await store.listDevices("uid-1"))[0].lastSeenAt).toBe(1000);
        await store.touchToken("dev_1", 62_000);
        expect((await store.listDevices("uid-1"))[0].lastSeenAt).toBe(62_000);
      });

      it("records an agent poll separately from any authenticated call", async () => {
        await store.putToken(token());
        await store.markAgentSeen("dev_1", "pub-key", undefined, 7000);
        const [device] = await store.listDevices("uid-1");
        expect(device.agentSeenAt).toBe(7000);
        expect(device.agentPublicKey).toBe("pub-key");
        /* A later poll without a key keeps the one already published. */
        await store.markAgentSeen("dev_1", undefined, undefined, 8000);
        expect((await store.listDevices("uid-1"))[0].agentPublicKey).toBe("pub-key");
      });

      it("keeps the harnesses a polling agent reported", async () => {
        await store.putToken(token());
        /* Nothing reported yet is not a claim that the machine has none. */
        expect((await store.listDevices("uid-1"))[0].harnesses).toBeUndefined();

        await store.markAgentSeen("dev_1", "pub-key", ["claude-code", "openclaw"], 7000);
        expect((await store.listDevices("uid-1"))[0].harnesses).toEqual([
          "claude-code",
          "openclaw",
        ]);

        /* A poll that carries no list leaves the last report standing. */
        await store.markAgentSeen("dev_1", undefined, undefined, 8000);
        expect((await store.listDevices("uid-1"))[0].harnesses).toEqual([
          "claude-code",
          "openclaw",
        ]);

        /* One that carries an empty list is a report of none, and replaces it. */
        await store.markAgentSeen("dev_1", undefined, [], 9000);
        expect((await store.listDevices("uid-1"))[0].harnesses).toEqual([]);
      });

      it("scopes a harness report to the device that sent it", async () => {
        await store.putToken(token());
        await store.putToken(token({ id: "dev_2", accessHash: "a2", refreshHash: "r2" }));
        await store.markAgentSeen("dev_2", undefined, ["codex"], 7000);
        const devices = await store.listDevices("uid-1");
        expect(devices.find((device) => device.id === "dev_2")?.harnesses).toEqual(["codex"]);
        expect(devices.find((device) => device.id === "dev_1")?.harnesses).toBeUndefined();
      });

      it("ignores an unknown id", async () => {
        await expect(store.touchToken("dev_nope")).resolves.toBeUndefined();
        await expect(store.markAgentSeen("dev_nope")).resolves.toBeUndefined();
      });

      it("finds the device a machine id names", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        const found = await store.deviceForMachine("uid-1", "machine-a");
        expect(found?.id).toBe("dev_1");
        expect(found?.refreshHash).toBe("refresh-hash");
      });

      it("returns null for a machine this account has never linked", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        expect(await store.deviceForMachine("uid-1", "machine-b")).toBeNull();
        /* A row that names no machine is not a match for anything. */
        await store.putToken(token({ id: "dev_2", accessHash: "a2", refreshHash: "r2" }));
        expect(await store.deviceForMachine("uid-1", "")).toBeNull();
      });

      /*
       * Unlinking revokes the row rather than deleting it, and a session
       * started before that still names it. Following the machine back is the
       * only route from a dead device to the one carrying its work now, so
       * this lookup deliberately ignores revoked_at.
       */
      it("still names the machine a revoked device belonged to", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        await store.revokeDevice("uid-1", "dev_1", 4000);
        expect(await store.machineForDevice("uid-1", "dev_1")).toBe("machine-a");
      });

      it("has no machine for a device that never named one", async () => {
        await store.putToken(token({ machineId: undefined }));
        expect(await store.machineForDevice("uid-1", "dev_1")).toBeNull();
      });

      it("never reads another account's device", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        expect(await store.machineForDevice("uid-2", "dev_1")).toBeNull();
      });

      it("never crosses accounts, however the machine id was learned", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        expect(await store.deviceForMachine("uid-2", "machine-a")).toBeNull();
      });

      it("ignores a revoked device, so unlinking survives the next login", async () => {
        await store.putToken(token({ machineId: "machine-a" }));
        expect(await store.revokeDevice("uid-1", "dev_1", 4000)).toBe(true);
        expect(await store.deviceForMachine("uid-1", "machine-a")).toBeNull();
      });
    });

    describe("sessions", () => {
      beforeEach(async () => {
        await store.putOrganization(organization());
      });

      it("reports whether a session was new", async () => {
        expect(await store.upsertSession(session())).toBe(true);
        expect(await store.upsertSession(session())).toBe(false);
      });

      it("keeps a handoff when a persistent session re-registers", async () => {
        await store.upsertSession(session());
        await store.assignSession("org_1", "s1", ["uid-2"]);
        await store.upsertSession(session({ assigneeUid: "uid-1" }));
        expect((await store.sessionInOrg("org_1", "s1"))?.assigneeUid).toBe("uid-2");
      });

      it("keeps multiple assignees, including an intentional empty set", async () => {
        await store.upsertSession(session());
        await store.assignSession("org_1", "s1", ["uid-1", "uid-2"]);
        expect((await store.sessionInOrg("org_1", "s1"))?.assigneeUids).toEqual([
          "uid-1",
          "uid-2",
        ]);
        await store.assignSession("org_1", "s1", []);
        await store.upsertSession(session({ assigneeUid: "uid-1" }));
        expect((await store.sessionInOrg("org_1", "s1"))?.assigneeUids).toEqual([]);
      });

      it("scopes a list to one account and one organization", async () => {
        await store.upsertSession(session());
        await store.upsertSession(session({ id: "s2", uid: "uid-2", startedAt: 3000 }));
        await store.upsertSession(session({ id: "s3", uid: "uid-3", orgId: "org_2" }));
        expect((await store.listSessions("uid-1")).map((entry) => entry.id)).toEqual(["s1"]);
        expect((await store.listOrgSessions("org_1")).map((entry) => entry.id)).toEqual(["s2", "s1"]);
      });

      it("patches a session and leaves untouched fields alone", async () => {
        await store.upsertSession(session());
        const patched = await store.patchSession("uid-1", "s1", { closedAt: 4000, exitCode: 0 });
        expect(patched?.closedAt).toBe(4000);
        expect(patched?.exitCode).toBe(0);
        expect(patched?.command).toBe("htop");
      });

      it("refuses to patch another account's session", async () => {
        await store.upsertSession(session());
        expect(await store.patchSession("uid-2", "s1", { closedAt: 4000 })).toBeNull();
      });

      it("replaces a sealed password for the same person and keeps the others", async () => {
        await store.upsertSession(session());
        await store.putKeyShares("org_1", "s1", [
          { uid: "uid-1", senderPublicKey: "pk1", sealed: "one" },
          { uid: "uid-2", senderPublicKey: "pk1", sealed: "two" },
        ]);
        await store.putKeyShares("org_1", "s1", [
          { uid: "uid-2", senderPublicKey: "pk2", sealed: "rotated" },
        ]);
        const shares = (await store.sessionInOrg("org_1", "s1"))?.keyShares ?? [];
        expect(shares).toHaveLength(2);
        expect(shares.find((share) => share.uid === "uid-2")?.sealed).toBe("rotated");
        expect(shares.find((share) => share.uid === "uid-1")?.sealed).toBe("one");
      });

      it("removes a session's row and reports whether there was one", async () => {
        await store.upsertSession(session());
        expect(await store.deleteSession("org_1", "s1")).toBe(true);
        expect(await store.sessionInOrg("org_1", "s1")).toBeNull();
        expect(await store.deleteSession("org_1", "s1")).toBe(false);
      });

      it("refuses to delete another organization's session", async () => {
        await store.upsertSession(session());
        expect(await store.deleteSession("org_2", "s1")).toBe(false);
        expect(await store.sessionInOrg("org_1", "s1")).not.toBeNull();
      });

      /*
       * Removing a session is itself an audited act. A trail that vanished
       * with its subject would record nothing worth keeping.
       */
      it("keeps the audit trail of a session it deleted", async () => {
        await store.upsertSession(session());
        await store.putAudit(auditEvent({ id: "gone", kind: "deleted", text: "htop" }));
        await store.deleteSession("org_1", "s1");
        expect((await store.auditFor("org_1", "s1")).map((entry) => entry.id)).toEqual(["gone"]);
      });

      it("says so when the session is not in the organization", async () => {
        await store.upsertSession(session());
        expect(await store.putKeyShares("org_2", "s1", [])).toBe(false);
        expect(await store.assignSession("org_2", "s1", ["uid-2"])).toBeNull();
      });
    });

    describe("session vault", () => {
      type AccountKey = Parameters<Store["putAccountKey"]>[0];

      function vault(overrides: Partial<AccountKey> = {}): AccountKey {
        return {
          uid: "uid-1",
          publicKey: "pk-1",
          encryptedPrivateKey: "enc-1",
          recoveryWrap: "wrap-1",
          version: 1,
          createdAt: 1000,
          updatedAt: 1000,
          ...overrides,
        };
      }

      /* Two browsers setting up at once must not both believe they won. */
      it("creates a vault once and refuses a second", async () => {
        expect(await store.putAccountKey(vault())).toBe(true);
        expect(await store.putAccountKey(vault({ publicKey: "pk-2" }))).toBe(false);
        expect(await store.accountKey("uid-1")).toEqual(vault());
      });

      it("replaces a vault only at the version the reset expects", async () => {
        await store.putAccountKey(vault());
        const next = vault({ publicKey: "pk-2", version: 2, updatedAt: 2000 });
        expect(await store.putAccountKey(next, 5)).toBe(false);
        expect(await store.putAccountKey(next, 1)).toBe(true);
        expect(await store.accountKey("uid-1")).toEqual(next);
        /* The same reset replayed finds the version has moved on. */
        expect(await store.putAccountKey(vault({ publicKey: "pk-3", version: 2 }), 1)).toBe(false);
      });

      it("does not replace a vault that does not exist", async () => {
        expect(await store.putAccountKey(vault(), 1)).toBe(false);
        expect(await store.accountKey("uid-1")).toBeNull();
      });

      it("hands out each member's vault key with the roster, and only theirs", async () => {
        await store.putOrganization(organization());
        await store.putMembership(membership());
        await store.putMembership(
          membership({ uid: "uid-2", email: "bo@example.com", role: "member", joinedAt: 2000 }),
        );
        await store.putAccountKey(vault({ uid: "uid-2", publicKey: "pk-bo" }));
        const roster = await store.members("org_1");
        expect(roster.find((entry) => entry.uid === "uid-2")?.accountKey).toBe("pk-bo");
        expect(roster.find((entry) => entry.uid === "uid-1")?.accountKey).toBeUndefined();
      });
    });

    describe("agent commands", () => {
      it("hands queued work out exactly once", async () => {
        await store.putCommand(command());
        expect((await store.claimCommands("dev_1", 2000)).map((entry) => entry.id)).toEqual(["cmd_1"]);
        expect(await store.claimCommands("dev_1", 2001)).toEqual([]);
      });

      it("only hands a machine its own work", async () => {
        await store.putCommand(command());
        expect(await store.claimCommands("dev_2")).toEqual([]);
      });

      it("records a result once and refuses a second", async () => {
        await store.putCommand(command());
        await store.claimCommands("dev_1", 2000);
        expect(await store.finishCommand("dev_1", "cmd_1", "boom", 3000)).toBe(true);
        expect(await store.finishCommand("dev_1", "cmd_1", undefined, 3001)).toBe(false);
        const [entry] = await store.listCommands("uid-1");
        expect(entry.doneAt).toBe(3000);
        expect(entry.error).toBe("boom");
      });

      it("drops finished work once it has had time to be reported", async () => {
        await store.putCommand(command());
        await store.finishCommand("dev_1", "cmd_1", undefined, 1000);
        await store.purgeExpired(1000 + 9 * 60_000);
        expect(await store.listCommands("uid-1")).toHaveLength(1);
        await store.purgeExpired(1000 + 11 * 60_000);
        expect(await store.listCommands("uid-1")).toEqual([]);
      });
    });

    describe("organizations", () => {
      beforeEach(async () => {
        await store.putOrganization(organization());
      });

      it("renames only an organization that exists", async () => {
        expect(await store.renameOrganization("org_1", "Vulture Labs")).toBe(true);
        expect((await store.organization("org_1"))?.name).toBe("Vulture Labs");
        expect(await store.renameOrganization("org_nope", "Nothing")).toBe(false);
      });

      it("finds a membership by uid alone and lists members oldest first", async () => {
        await store.putMembership(membership());
        await store.putMembership(membership({ uid: "uid-2", role: "member", joinedAt: 500 }));
        expect((await store.membershipOf("uid-1"))?.role).toBe("owner");
        expect((await store.members("org_1")).map((entry) => entry.uid)).toEqual(["uid-2", "uid-1"]);
      });

      it("moves a person rather than leaving them in two organizations", async () => {
        await store.putOrganization(organization({ id: "org_2", name: "Other" }));
        await store.putMembership(membership());
        await store.putMembership(membership({ orgId: "org_2", role: "member" }));
        expect((await store.membershipOf("uid-1"))?.orgId).toBe("org_2");
        expect(await store.members("org_1")).toEqual([]);
      });

      it("stores a published browser key against the membership", async () => {
        await store.putMembership(membership());
        await store.setMemberKey("uid-1", "browser-key");
        expect((await store.membershipOf("uid-1"))?.publicKey).toBe("browser-key");
      });

      it("changes a role and removes a member", async () => {
        await store.putMembership(membership());
        expect(await store.setRole("org_1", "uid-1", "admin")).toBe(true);
        expect((await store.membershipOf("uid-1"))?.role).toBe("admin");
        expect(await store.removeMember("org_1", "uid-1")).toBe(true);
        expect(await store.removeMember("org_1", "uid-1")).toBe(false);
        expect(await store.membershipOf("uid-1")).toBeNull();
      });
    });

    describe("invites", () => {
      beforeEach(async () => {
        await store.putOrganization(organization());
      });

      it("reads an invite back whole", async () => {
        await store.putInvite(invite({ email: "bruno@example.com" }));
        const stored = await store.invite("inv_1");
        expect(stored?.email).toBe("bruno@example.com");
        expect(stored?.role).toBe("member");
        expect(stored?.expiresAt).toBe(9000);
      });

      it("has no invite to hand back for an unknown id", async () => {
        expect(await store.invite("inv_nope")).toBeUndefined();
      });

      it("records acceptance", async () => {
        await store.putInvite(invite());
        await store.claimInvite("inv_1", "uid-2", 4000);
        expect((await store.invite("inv_1"))?.acceptedBy).toBe("uid-2");
      });

      it("lets exactly one concurrent caller consume an invite", async () => {
        await store.putInvite(invite());
        const claims = await Promise.all([
          store.claimInvite("inv_1", "uid-2", 4000),
          store.claimInvite("inv_1", "uid-3", 4000),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(["uid-2", "uid-3"]).toContain((await store.invite("inv_1"))?.acceptedBy);
      });

      it("lists an organization's invites newest first", async () => {
        await store.putInvite(invite());
        await store.putInvite(invite({ id: "inv_2", createdAt: 3000 }));
        expect((await store.invites("org_1")).map((entry) => entry.id)).toEqual(["inv_2", "inv_1"]);
      });
    });

    describe("audit", () => {
      /*
       * The five-minute sweep used to delete every input and interrupt row,
       * which made recording them pointless: an entry survived until the next
       * cron tick and no longer. Input is retained on purpose now, so the
       * sweep must leave it alone, and this is where that is written down.
       */
      it("keeps recorded input rather than sweeping it away", async () => {
        await store.putAudit(auditEvent({ id: "typed", kind: "input", text: "secret command" }));
        await store.putAudit(auditEvent({ id: "handoff", kind: "handoff", text: "assigned" }));
        await store.purgeExpired();
        expect((await store.auditFor("org_1", "s1")).map((entry) => entry.id).sort()).toEqual([
          "handoff",
          "typed",
        ]);
      });

      it("reads one session's trail in the order it happened", async () => {
        await store.putAudit(auditEvent({ id: "a2", at: 2000, text: "second" }));
        await store.putAudit(auditEvent({ id: "a1", at: 1000, text: "first" }));
        await store.putAudit(auditEvent({ id: "a3", sessionId: "s2" }));
        expect((await store.auditFor("org_1", "s1")).map((entry) => entry.text)).toEqual([
          "first",
          "second",
        ]);
      });

      /*
       * Two events in the same millisecond are ordinary: a paste is several
       * lines of input at once. Without a tiebreaker the database is free to
       * return them in either order, so a trace could reorder between two
       * reads of the same history.
       */
      it("orders events in the same millisecond the same way every time", async () => {
        for (const id of ["a3", "a1", "a2"]) {
          await store.putAudit(auditEvent({ id, at: 1000, text: id }));
        }
        const once = (await store.auditFor("org_1", "s1")).map((entry) => entry.id);
        const again = (await store.auditFor("org_1", "s1")).map((entry) => entry.id);
        expect(once).toEqual(["a1", "a2", "a3"]);
        expect(again).toEqual(once);
      });

      it("keeps the most recent events when the window is smaller than the history", async () => {
        for (let index = 0; index < 5; index += 1) {
          await store.putAudit(auditEvent({ id: `a${index}`, at: 1000 + index, text: `${index}` }));
        }
        expect((await store.auditForOrg("org_1", 2)).map((entry) => entry.text)).toEqual(["3", "4"]);
      });

      it("pages a filtered organization trail newest first", async () => {
        await store.putAudit(auditEvent({ id: "a1", at: 1000, actorUid: "uid-1", text: "npm test" }));
        await store.putAudit(auditEvent({ id: "a2", at: 2000, actorUid: "uid-2", text: "git status" }));
        await store.putAudit(auditEvent({ id: "a3", at: 3000, actorUid: "uid-1", text: "npm run build" }));
        await store.putAudit(auditEvent({ id: "a4", at: 4000, actorUid: "uid-1", sessionId: "s2", text: "npm lint" }));

        const first = await store.auditPage("org_1", {
          limit: 1,
          offset: 0,
          actorUid: "uid-1",
          sessionId: "s1",
          query: "NPM",
        });
        const second = await store.auditPage("org_1", {
          limit: 1,
          offset: 1,
          actorUid: "uid-1",
          sessionId: "s1",
          query: "npm",
        });

        expect(first.total).toBe(2);
        expect(first.events.map((entry) => entry.id)).toEqual(["a3"]);
        expect(second.events.map((entry) => entry.id)).toEqual(["a1"]);
      });
    });

    describe("comments and notifications", () => {
      it("reads a session's comments in order, with their mentions", async () => {
        await store.putComment({
          id: "c1",
          orgId: "org_1",
          sessionId: "s1",
          authorUid: "uid-1",
          body: "@Bruno Sá look",
          at: 1000,
          mentions: ["uid-2"],
        });
        const [comment] = await store.comments("org_1", "s1");
        expect(comment.mentions).toEqual(["uid-2"]);
        expect(await store.comments("org_1", "s2")).toEqual([]);
      });

      it("shows one person's inbox newest first", async () => {
        await store.putNotification(notification());
        await store.putNotification(notification({ id: "ntf_2", at: 3000 }));
        await store.putNotification(notification({ id: "ntf_3", uid: "uid-3" }));
        expect((await store.notificationsFor("uid-2")).map((entry) => entry.id)).toEqual([
          "ntf_2",
          "ntf_1",
        ]);
      });

      it("orders an inbox with the same timestamp the same way every time", async () => {
        for (const id of ["ntf_b", "ntf_c", "ntf_a"]) {
          await store.putNotification(notification({ id, at: 1000 }));
        }
        const ids = (await store.notificationsFor("uid-2")).map((entry) => entry.id);
        expect(ids).toEqual(["ntf_c", "ntf_b", "ntf_a"]);
      });

      it("marks one as read, once, and only for its owner", async () => {
        await store.putNotification(notification());
        expect(await store.markNotificationRead("uid-3", "ntf_1", 5000)).toBe(false);
        expect(await store.markNotificationRead("uid-2", "ntf_1", 5000)).toBe(true);
        expect(await store.markNotificationRead("uid-2", "ntf_1", 5001)).toBe(false);
        expect((await store.notificationsFor("uid-2"))[0].readAt).toBe(5000);
      });

      it("counts what marking everything read actually changed", async () => {
        await store.putNotification(notification());
        await store.putNotification(notification({ id: "ntf_2", readAt: 100 }));
        expect(await store.markAllNotificationsRead("uid-2", 5000)).toBe(1);
        expect(await store.markAllNotificationsRead("uid-2", 5000)).toBe(0);
      });
    });

    describe("claiming an organization on first sight", () => {
      /*
       * Signing in fires several requests at once. On a new account none of
       * them finds a membership, so each tries to create an organization and
       * claim the same person. Against Postgres the losers hit the unique
       * index on uid, which surfaced as a 500 on the first page load.
       */
      it("gives every racing caller the same membership", async () => {
        const attempts = Array.from({ length: 8 }, (_, index) =>
          store.claimOwnOrganization(
            organization({ id: `org_race_${index}`, createdBy: "uid-new" }),
            membership({ orgId: `org_race_${index}`, uid: "uid-new", role: "owner" }),
          ),
        );
        const claimed = await Promise.all(attempts);

        /* One organization won, and everybody was told the same one. */
        const orgIds = new Set(claimed.map((entry) => entry.orgId));
        expect(orgIds.size).toBe(1);
        expect(await store.membershipOf("uid-new")).toMatchObject({ orgId: [...orgIds][0] });
      });

      /* The organizations the losers made must not be left lying around. */
      it("leaves no organization behind for a caller that lost", async () => {
        const claimed = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            store.claimOwnOrganization(
              organization({ id: `org_orphan_${index}`, createdBy: "uid-solo" }),
              membership({ orgId: `org_orphan_${index}`, uid: "uid-solo", role: "owner" }),
            ),
          ),
        );
        const winner = claimed[0].orgId;
        for (let index = 0; index < 5; index += 1) {
          const id = `org_orphan_${index}`;
          const found = await store.organization(id);
          if (id === winner) expect(found).not.toBeNull();
          else expect(found).toBeNull();
        }
      });

      it("yields to a membership that already exists", async () => {
        await store.putOrganization(organization());
        await store.putMembership(membership());
        const claimed = await store.claimOwnOrganization(
          organization({ id: "org_late", createdBy: "uid-1" }),
          membership({ orgId: "org_late", uid: "uid-1" }),
        );
        expect(claimed.orgId).toBe("org_1");
        expect(await store.organization("org_late")).toBeNull();
      });
    });

    describe("moving somebody between organizations", () => {
      /*
       * The old implementation deleted the person's other memberships and then
       * inserted, which is not atomic: a caller that lost the race had already
       * deleted the winner's row, leaving the person in no organization at all.
       */
      it("never leaves a person with no organization", async () => {
        await store.putOrganization(organization());
        await store.putOrganization(organization({ id: "org_2", name: "Other" }));
        await store.putMembership(membership());

        await Promise.all([
          store.putMembership(membership({ orgId: "org_2" })),
          store.putMembership(membership({ orgId: "org_1" })),
          store.putMembership(membership({ orgId: "org_2" })),
        ]);

        const after = await store.membershipOf("uid-1");
        expect(after).not.toBeNull();
        expect(["org_1", "org_2"]).toContain(after?.orgId);
      });
    });

    describe("account deletion", () => {
      async function team() {
        await store.putOrganization(organization());
        await store.putMembership(membership());
        await store.putMembership(
          membership({ uid: "uid-2", email: "bo@example.com", name: "Bo", role: "member", joinedAt: 2000 }),
        );
        await store.putMembership(
          membership({ uid: "uid-3", email: "cy@example.com", name: "Cy", role: "admin", joinedAt: 3000 }),
        );
      }

      it("removes what the account held and keeps the team's trail without its email", async () => {
        await team();
        await store.putToken(token());
        await store.putCommand(command());
        await store.upsertSession(session());
        await store.upsertSession(
          session({ id: "s2", uid: "uid-2", ownerUid: "uid-2", assigneeUid: "uid-1", assigneeUids: ["uid-1", "uid-3"] }),
        );
        await store.putKeyShares("org_1", "s2", [
          { uid: "uid-1", senderPublicKey: "spk", sealed: "for-ana" },
          { uid: "uid-3", senderPublicKey: "spk", sealed: "for-cy" },
        ]);
        await store.putAccountKey({
          uid: "uid-1",
          publicKey: "pk",
          encryptedPrivateKey: "enc",
          recoveryWrap: "wrap",
          version: 1,
          createdAt: 1000,
          updatedAt: 1000,
        });
        await store.putAudit(auditEvent({ sessionId: "s2" }));
        await store.putComment({
          id: "cmt_1",
          orgId: "org_1",
          sessionId: "s2",
          authorUid: "uid-1",
          body: "looks done",
          at: 1000,
          mentions: [],
        });
        await store.putNotification(notification());
        await store.putNotification(notification({ id: "ntf_2", uid: "uid-1", actorUid: "uid-2" }));

        await store.deleteAccount("uid-1", { orgId: "org_1", dissolve: false, successorUid: "uid-3" }, 5000);

        expect(await store.membershipOf("uid-1")).toBeNull();
        expect((await store.membershipOf("uid-3"))?.role).toBe("owner");
        expect((await store.membershipOf("uid-2"))?.role).toBe("member");
        expect(await store.findByAccessHash("access-hash")).toBeNull();
        expect(await store.listCommands("uid-1")).toEqual([]);
        expect(await store.listSessions("uid-1")).toEqual([]);
        expect(await store.accountKey("uid-1")).toBeNull();
        expect(await store.comments("org_1", "s2")).toEqual([]);
        expect(await store.notificationsFor("uid-1")).toEqual([]);
        expect(await store.notificationsFor("uid-2")).toEqual([]);

        const kept = (await store.listOrgSessions("org_1")).find((entry) => entry.id === "s2");
        expect(kept?.assigneeUids).toEqual(["uid-3"]);
        expect(kept?.assigneeUid).toBe("uid-3");
        expect(kept?.keyShares?.map((share) => share.uid)).toEqual(["uid-3"]);

        const trail = await store.auditFor("org_1", "s2");
        expect(trail).toHaveLength(1);
        expect(trail[0].actorEmail).toBe(DELETED_ACTOR_EMAIL);
        expect(trail[0].text).toBe("ls -la");
      });

      it("dissolves a team nobody else is in", async () => {
        await store.putOrganization(organization());
        await store.putMembership(membership());
        await store.putInvite(invite());
        await store.upsertSession(session());
        await store.putAudit(auditEvent());

        await store.deleteAccount("uid-1", { orgId: "org_1", dissolve: true }, 5000);

        expect(await store.organization("org_1")).toBeNull();
        expect(await store.members("org_1")).toEqual([]);
        expect(await store.invites("org_1")).toEqual([]);
        expect(await store.listOrgSessions("org_1")).toEqual([]);
        expect(await store.auditFor("org_1", "s1")).toEqual([]);
      });

      it("forgets the address an invite was sent to once its recipient is gone", async () => {
        await team();
        await store.putInvite(invite({ email: "bo@example.com", acceptedBy: "uid-2", acceptedAt: 2000 }));

        await store.deleteAccount("uid-2", { orgId: "org_1", dissolve: false }, 5000);

        expect((await store.invite("inv_1"))?.email).toBeFalsy();
        expect((await store.membershipOf("uid-1"))?.role).toBe("owner");
      });

      it("remembers a deleted uid for DELETED_ACCOUNT_MEMORY_MS and no longer", async () => {
        await store.deleteAccount("uid-9", { dissolve: false }, 5000);

        expect(await store.recentlyDeleted("uid-9", 4000)).toBe(true);
        expect(await store.recentlyDeleted("uid-9", 6000)).toBe(false);
        expect(await store.recentlyDeleted("uid-8", 0)).toBe(false);

        await store.purgeExpired(5000 + DELETED_ACCOUNT_MEMORY_MS);
        expect(await store.recentlyDeleted("uid-9", 0)).toBe(false);
      });
    });
  });
}
