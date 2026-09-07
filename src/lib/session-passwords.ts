/**
 * Passwords for sessions this browser started.
 *
 * A session started from here has a password this browser chose, so there is
 * nothing to prompt for. It is kept in localStorage, per origin, and never
 * sent anywhere: the accounts service only ever saw it sealed to the machine.
 *
 * Sessions started from a terminal are not in here, and still prompt.
 */

const KEY = "shell.online:session-passwords:v2";
const MAX_ENTRIES = 50;

type Store = Record<string, string>;

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

/** Remembers a password against the request that will produce a session. */
export function rememberForOrigin(origin: string, password: string): void {
  if (!origin || !password) return;
  const store = read();
  store[scoped(`origin:${origin}`)] = password;
  write(trim(store));
}

/** Moves a remembered password onto the session that finally appeared. */
export function adoptOrigin(origin: string | undefined, sessionId: string): void {
  if (!origin || !sessionId) return;
  const store = read();
  const password = store[scoped(`origin:${origin}`)];
  if (!password) return;
  delete store[scoped(`origin:${origin}`)];
  store[scoped(`session:${sessionId}`)] = password;
  write(trim(store));
}

/** Records a password against a session directly. */
export function rememberFor(sessionId: string, password: string): void {
  if (!sessionId || !password) return;
  const store = read();
  store[scoped(`session:${sessionId}`)] = password;
  write(trim(store));
}

export function passwordFor(sessionId: string): string | null {
  return read()[scoped(`session:${sessionId}`)] ?? null;
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
