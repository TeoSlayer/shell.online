/**
 * Passwords for sessions this browser started.
 *
 * A session started from here has a password this browser chose, so there is
 * nothing to prompt for. It is kept in localStorage, per origin, and never
 * sent anywhere: the accounts service only ever saw it sealed to the machine.
 *
 * Sessions started from a terminal are not in here, and still prompt.
 */

const KEY = "shell.online:session-passwords:v1";
const MAX_ENTRIES = 50;

type Store = Record<string, string>;

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
  store[`origin:${origin}`] = password;
  write(trim(store));
}

/** Moves a remembered password onto the session that finally appeared. */
export function adoptOrigin(origin: string | undefined, sessionId: string): void {
  if (!origin || !sessionId) return;
  const store = read();
  const password = store[`origin:${origin}`];
  if (!password) return;
  delete store[`origin:${origin}`];
  store[`session:${sessionId}`] = password;
  write(trim(store));
}

export function passwordFor(sessionId: string): string | null {
  return read()[`session:${sessionId}`] ?? null;
}

export function forget(sessionId: string): void {
  const store = read();
  delete store[`session:${sessionId}`];
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
