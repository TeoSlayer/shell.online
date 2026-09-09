/**
 * Passwords for sessions this browser knows, and who they were shared with.
 *
 * A session started from here has a password this browser chose, so there is
 * nothing to prompt for. A password typed into the gate is kept too, so a
 * session started from a terminal asks once rather than on every reload. It
 * lives in localStorage, per origin, and is never sent anywhere: the accounts
 * service only ever saw it sealed to a machine or to a colleague.
 *
 * The audience is stored with it because it is the same secret: it is the list
 * of colleagues this browser has sealed the password to. The service is not
 * asked who that is, because the service is not trusted with the password and
 * should not be the record of who can read it either.
 */

const KEY = "shell.online:session-passwords:v3";
const MAX_ENTRIES = 50;

interface Entry {
  password: string;
  /** Team members this password has been, or is to be, sealed to. */
  audience?: string[];
}

type Store = Record<string, Entry>;

/*
 * Scoped to the signed-in account. Without this, signing out and signing in as
 * somebody else on the same computer handed the new person every session
 * password the previous one had collected.
 */
let owner = "";

export function setPasswordOwner(uid: string): void {
  if (uid === owner) return;
  owner = uid;
}

function scoped(key: string): string {
  return `${owner}\u0000${key}`;
}

/** Forgets everything held for the account signing out. */
export function forgetAll(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    /* private windows and blocked storage both land here */
    return {};
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* nothing to do; the password simply will not be remembered */
  }
}

/** Remembers a password, and its audience, against the request that will produce a session. */
export function rememberForOrigin(origin: string, password: string, audience: string[] = []): void {
  if (!origin || !password) return;
  const store = read();
  store[scoped(`origin:${origin}`)] = { password, audience: [...audience] };
  write(trim(store));
}

/** Moves a remembered password onto the session that finally appeared. */
export function adoptOrigin(origin: string | undefined, sessionId: string): void {
  if (!origin || !sessionId) return;
  const store = read();
  const entry = store[scoped(`origin:${origin}`)];
  if (!entry) return;
  delete store[scoped(`origin:${origin}`)];
  store[scoped(`session:${sessionId}`)] = entry;
  write(trim(store));
}

/** Records a password against a session directly, keeping any audience it has. */
export function rememberFor(sessionId: string, password: string): void {
  if (!sessionId || !password) return;
  const store = read();
  const key = scoped(`session:${sessionId}`);
  store[key] = { password, audience: store[key]?.audience ?? [] };
  write(trim(store));
}

export function passwordFor(sessionId: string): string | null {
  return read()[scoped(`session:${sessionId}`)]?.password ?? null;
}

/** Who this browser has sealed the password to, besides the person holding it. */
export function audienceFor(sessionId: string): string[] {
  return read()[scoped(`session:${sessionId}`)]?.audience ?? [];
}

/**
 * Adds people to a session's audience.
 *
 * Only ever adds. Taking someone off the list would not take the copy they
 * already hold out of their browser, so a control that appeared to revoke
 * would be lying about what it did.
 */
export function addToAudience(sessionId: string, uids: string[]): string[] {
  const store = read();
  const key = scoped(`session:${sessionId}`);
  const entry = store[key];
  if (!entry) return [];
  const audience = new Set(entry.audience ?? []);
  for (const uid of uids) if (uid) audience.add(uid);
  entry.audience = [...audience];
  store[key] = entry;
  write(trim(store));
  return entry.audience;
}

export function forget(sessionId: string): void {
  const store = read();
  delete store[scoped(`session:${sessionId}`)];
  write(store);
}

/* Oldest keys go first, so a long-lived browser does not grow without bound. */
function trim(store: Store): Store {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return store;
  const trimmed: Store = {};
  for (const key of keys.slice(keys.length - MAX_ENTRIES)) trimmed[key] = store[key];
  return trimmed;
}
