/**
 * How a person is shown, everywhere.
 *
 * One module so a colleague looks the same in the session table, the audit
 * log, a comment and a notification. Account ids are an implementation
 * detail: they identify people to the service, never to a reader.
 */

export interface Person {
  uid: string;
  name?: string;
  email?: string;
}

/**
 * A palette of solid colours, each dark enough for white text.
 *
 * Chosen to sit beside the warm paper rather than fight it, and spread around
 * the wheel so two people in a small team rarely collide.
 */
export const AVATAR_COLORS = [
  "#3f6cd4", "#2f7d63", "#a2542f", "#7b4fbd", "#177b8a",
  "#96406b", "#4a6b25", "#b1502c", "#3a5c96", "#6b6320",
  "#8a3a52", "#2c6f52",
] as const;

/** Stable across reloads, machines and people: derived only from the id. */
export function avatarColor(uid: string): string {
  let hash = 0;
  for (let index = 0; index < uid.length; index += 1) {
    hash = (hash * 31 + uid.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** The name to show. Falls back through the email's local part, never the id. */
export function displayName(person: Person | null | undefined): string {
  if (!person) return "Unknown";
  const name = person.name?.trim();
  if (name) return name;
  const local = person.email?.split("@")[0]?.trim();
  if (local) return local;
  return "Unknown";
}

/** A short form for tight places, such as a session row. */
export function shortName(person: Person | null | undefined): string {
  const full = displayName(person);
  const [first, second] = full.split(/\s+/);
  /* Two initials read as a person; one long word is left whole. */
  return second ? `${first} ${second.charAt(0).toUpperCase()}.` : first;
}

/**
 * One or two initials.
 *
 * From the name where there is one, so "Ana Ferreira" is AF, and from the
 * email otherwise. Never from the id, which would produce noise.
 */
export function initials(person: Person | null | undefined): string {
  const name = person?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  const local = person?.email?.split("@")[0]?.replace(/[^A-Za-z0-9]/g, "");
  if (local) return local.slice(0, 2).toUpperCase();
  return "?";
}

/** Finds a person in a roster, so callers never index by id themselves. */
export function findPerson<T extends Person>(people: T[], uid?: string): T | undefined {
  return uid ? people.find((person) => person.uid === uid) : undefined;
}
