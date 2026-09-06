import { DurableObject } from "cloudflare:workers";
import { hashPassword, randomHex, verifyPassword } from "./account-auth";

export interface AccountRecord {
  id: string;
  email: string;
}

export interface SavedLink {
  session_id: string;
  label: string;
  saved_at: number;
}

/**
 * Single-instance SQLite store for optional accounts and the links they save.
 *
 * Shares themselves are untouched by this: a session works exactly the same
 * whether or not anyone has an account, and nothing here is on the hot path.
 */
export class AccountsStore extends DurableObject<Record<string, never>> {
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState, env: Record<string, never>) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_links (
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, session_id)
      );
    `);
  }

  async register(email: string, password: string): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string }> {
    const existing = [...this.sql.exec("SELECT id FROM accounts WHERE email = ?", email)];
    if (existing.length > 0) return { ok: false, error: "email already registered" };
    const { salt, hash } = await hashPassword(password);
    const id = randomHex(16);
    this.sql.exec(
      "INSERT INTO accounts (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      id, email, salt, hash, Date.now(),
    );
    return { ok: true, account: { id, email } };
  }

  async login(email: string, password: string): Promise<AccountRecord | null> {
    const rows = [...this.sql.exec(
      "SELECT id, email, password_salt, password_hash FROM accounts WHERE email = ?", email,
    )] as unknown as Array<{ id: string; email: string; password_salt: string; password_hash: string }>;
    if (rows.length === 0) {
      // Spend comparable time so a missing address is not obvious from timing.
      await hashPassword(password);
      return null;
    }
    const row = rows[0];
    const valid = await verifyPassword(password, row.password_salt, row.password_hash);
    return valid ? { id: row.id, email: row.email } : null;
  }

  async accountById(id: string): Promise<AccountRecord | null> {
    const rows = [...this.sql.exec("SELECT id, email FROM accounts WHERE id = ?", id)] as unknown as AccountRecord[];
    return rows.length > 0 ? rows[0] : null;
  }

  async updateEmail(accountId: string, email: string): Promise<{ ok: boolean; error?: string }> {
    const taken = [...this.sql.exec("SELECT id FROM accounts WHERE email = ? AND id != ?", email, accountId)];
    if (taken.length > 0) return { ok: false, error: "email already registered" };
    this.sql.exec("UPDATE accounts SET email = ? WHERE id = ?", email, accountId);
    return { ok: true };
  }

  async updatePassword(accountId: string, currentPassword: string, nextPassword: string): Promise<{ ok: boolean; error?: string }> {
    const rows = [...this.sql.exec(
      "SELECT password_salt, password_hash FROM accounts WHERE id = ?", accountId,
    )] as unknown as Array<{ password_salt: string; password_hash: string }>;
    if (rows.length === 0) return { ok: false, error: "account not found" };
    const valid = await verifyPassword(currentPassword, rows[0].password_salt, rows[0].password_hash);
    if (!valid) return { ok: false, error: "current password is incorrect" };
    const { salt, hash } = await hashPassword(nextPassword);
    this.sql.exec("UPDATE accounts SET password_salt = ?, password_hash = ? WHERE id = ?", salt, hash, accountId);
    return { ok: true };
  }

  /** Removes the account and every link it saved. Shares themselves keep running. */
  async deleteAccount(accountId: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const rows = [...this.sql.exec(
      "SELECT password_salt, password_hash FROM accounts WHERE id = ?", accountId,
    )] as unknown as Array<{ password_salt: string; password_hash: string }>;
    if (rows.length === 0) return { ok: false, error: "account not found" };
    const valid = await verifyPassword(password, rows[0].password_salt, rows[0].password_hash);
    if (!valid) return { ok: false, error: "password is incorrect" };
    this.sql.exec("DELETE FROM account_links WHERE account_id = ?", accountId);
    this.sql.exec("DELETE FROM accounts WHERE id = ?", accountId);
    return { ok: true };
  }

  async saveLink(accountId: string, sessionId: string, label: string): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO account_links (account_id, session_id, label, saved_at) VALUES (?, ?, ?, ?)",
      accountId, sessionId, label.slice(0, 120), Date.now(),
    );
  }

  async removeLink(accountId: string, sessionId: string): Promise<void> {
    this.sql.exec("DELETE FROM account_links WHERE account_id = ? AND session_id = ?", accountId, sessionId);
  }

  async listLinks(accountId: string): Promise<SavedLink[]> {
    return [...this.sql.exec(
      "SELECT session_id, label, saved_at FROM account_links WHERE account_id = ? ORDER BY saved_at DESC LIMIT 200",
      accountId,
    )] as unknown as SavedLink[];
  }
}
