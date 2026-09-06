import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export interface AuthorizationCode {
  code: string;
  uid: string;
  email: string;
  name: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
  consumedAt?: number;
}

export interface CliToken {
  /** Stable public id for this device. Safe to show and to address in a URL. */
  id: string;
  /** SHA-256 of the presented secret. The secret itself is never stored. */
  accessHash: string;
  refreshHash: string;
  uid: string;
  email: string;
  name: string;
  label: string;
  accessExpiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

/** A linked machine, with every secret removed. */
export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface SessionRecord {
  id: string;
  uid: string;
  shareUrl: string;
  command: string;
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  host: string;
  startedAt: number;
  closedAt?: number;
  exitCode?: number;
}

/**
 * Work the web app asks a machine to do. A machine only sees these while it is
 * running `shell agent`, which is how a person opts a machine in to being
 * driven from the browser.
 */
export interface AgentCommand {
  id: string;
  uid: string;
  deviceId: string;
  kind: "start" | "kill";
  /** For "start": the command line to wrap. */
  command?: string;
  /** For "kill": the session to stop. */
  sessionId?: string;
  createdAt: number;
  claimedAt?: number;
  doneAt?: number;
  error?: string;
}

interface Shape {
  codes: AuthorizationCode[];
  tokens: CliToken[];
  sessions: SessionRecord[];
  commands: AgentCommand[];
}

const EMPTY: Shape = { codes: [], tokens: [], sessions: [], commands: [] };

/**
 * File-backed store for local development. Every read and write goes through
 * this interface so the production implementation (Firestore, D1) can drop in
 * without touching route code.
 */
export class Store {
  private data: Shape;

  constructor(private readonly path: string | null) {
    this.data = this.read();
    this.migrate();
  }

  /*
   * Fills in fields added after a record was first written. Doing it once on
   * load keeps every reader simple: a token in memory always has an id and a
   * lastSeenAt, so nothing downstream has to cope with a half-shaped record.
   */
  private migrate(): void {
    let changed = false;
    for (const token of this.data.tokens) {
      if (!token.id) {
        token.id = `dev_${randomBytes(16).toString("hex")}`;
        changed = true;
      }
      if (typeof token.lastSeenAt !== "number") {
        token.lastSeenAt = token.createdAt;
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  static memory(): Store {
    return new Store(null);
  }

  private read(): Shape {
    if (!this.path) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Shape>;
      return {
        codes: parsed.codes ?? [],
        tokens: parsed.tokens ?? [],
        sessions: parsed.sessions ?? [],
        commands: parsed.commands ?? [],
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    /* Write to a sibling then rename, so a crash cannot leave a half file. */
    const temporary = join(dirname(this.path), `.${Date.now()}.tmp`);
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  putCode(code: AuthorizationCode): void {
    this.data.codes = this.data.codes.filter((entry) => entry.code !== code.code);
    this.data.codes.push(code);
    this.flush();
  }

  /*
   * Marks the code consumed and reports whether it already was. Returning the
   * flag rather than comparing timestamps keeps replay detection independent
   * of clock ordering between the stamp and the caller's own clock.
   */
  takeCode(
    code: string,
    now = Date.now(),
  ): { entry: AuthorizationCode; alreadyConsumed: boolean } | null {
    const found = this.data.codes.find((entry) => entry.code === code);
    if (!found) return null;
    const alreadyConsumed = found.consumedAt !== undefined;
    if (!alreadyConsumed) {
      found.consumedAt = now;
      this.flush();
    }
    return { entry: found, alreadyConsumed };
  }

  putToken(token: CliToken): void {
    this.data.tokens.push(token);
    this.flush();
  }

  findByAccessHash(hash: string): CliToken | null {
    return this.data.tokens.find((entry) => entry.accessHash === hash) ?? null;
  }

  findByRefreshHash(hash: string): CliToken | null {
    return this.data.tokens.find((entry) => entry.refreshHash === hash) ?? null;
  }

  updateToken(refreshHash: string, patch: Partial<CliToken>): void {
    const token = this.data.tokens.find((entry) => entry.refreshHash === refreshHash);
    if (!token) return;
    Object.assign(token, patch);
    this.flush();
  }

  /*
   * Touching lastSeenAt on every authenticated call would mean a write per
   * request. The resolution only needs to be useful to a person reading a
   * device list, so it settles for a minute.
   */
  touchToken(id: string, now = Date.now(), resolutionMs = 60_000): void {
    const token = this.data.tokens.find((entry) => entry.id === id);
    if (!token || now - token.lastSeenAt < resolutionMs) return;
    token.lastSeenAt = now;
    this.flush();
  }

  /** Devices for one account, secrets stripped, newest first. */
  listDevices(uid: string): Device[] {
    return this.data.tokens
      .filter((entry) => entry.uid === uid && !entry.revokedAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, label, createdAt, lastSeenAt, revokedAt }) => ({
        id,
        label,
        createdAt,
        lastSeenAt,
        revokedAt,
      }));
  }

  /* Scoped by uid so one account cannot revoke another account's machine. */
  revokeDevice(uid: string, id: string, now = Date.now()): boolean {
    const token = this.data.tokens.find(
      (entry) => entry.id === id && entry.uid === uid && !entry.revokedAt,
    );
    if (!token) return false;
    token.revokedAt = now;
    this.flush();
    return true;
  }

  upsertSession(session: SessionRecord): void {
    const index = this.data.sessions.findIndex(
      (entry) => entry.id === session.id && entry.uid === session.uid,
    );
    if (index >= 0) {
      this.data.sessions[index] = { ...this.data.sessions[index], ...session };
    } else {
      this.data.sessions.push(session);
    }
    this.flush();
  }

  patchSession(uid: string, id: string, patch: Partial<SessionRecord>): SessionRecord | null {
    const session = this.data.sessions.find((entry) => entry.id === id && entry.uid === uid);
    if (!session) return null;
    Object.assign(session, patch);
    this.flush();
    return session;
  }

  /* Scoped by uid at the store boundary so a route cannot leak another account. */
  listSessions(uid: string): SessionRecord[] {
    return this.data.sessions
      .filter((entry) => entry.uid === uid)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  putCommand(command: AgentCommand): void {
    this.data.commands.push(command);
    this.flush();
  }

  /*
   * Hands a machine everything queued for it and marks it claimed in the same
   * step, so two agents on one device cannot both run the same command.
   */
  claimCommands(deviceId: string, now = Date.now()): AgentCommand[] {
    const claimed = this.data.commands.filter(
      (entry) => entry.deviceId === deviceId && !entry.claimedAt,
    );
    if (claimed.length === 0) return [];
    for (const entry of claimed) entry.claimedAt = now;
    this.flush();
    return claimed;
  }

  finishCommand(deviceId: string, id: string, error: string | undefined, now = Date.now()): boolean {
    const entry = this.data.commands.find(
      (candidate) => candidate.id === id && candidate.deviceId === deviceId,
    );
    if (!entry || entry.doneAt) return false;
    entry.doneAt = now;
    if (error) entry.error = error;
    this.flush();
    return true;
  }

  listCommands(uid: string, limit = 20): AgentCommand[] {
    return this.data.commands
      .filter((entry) => entry.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  purgeExpired(now = Date.now()): void {
    const before = this.data.codes.length;
    this.data.codes = this.data.codes.filter((entry) => entry.expiresAt > now);
    /* Finished commands are only kept long enough to be reported back. */
    const commandsBefore = this.data.commands.length;
    this.data.commands = this.data.commands.filter(
      (entry) => !entry.doneAt || now - entry.doneAt < 10 * 60_000,
    );
    if (this.data.codes.length !== before || this.data.commands.length !== commandsBefore) {
      this.flush();
    }
  }
}
