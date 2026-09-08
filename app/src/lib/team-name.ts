/**
 * The team name offered at signup.
 *
 * Mirrors `suggestOrgName` in server/lib/orgs.ts, which is what the service
 * falls back to when nobody chooses one. Showing the same guess as the
 * placeholder means the field can be left alone and still produce the name the
 * account would have had anyway, rather than presenting an empty box that must
 * be filled before anyone can get in.
 */

/*
 * Addresses that say nothing about who someone works with, so the domain is
 * not worth turning into a company name. Kept in step with the server's list.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "fastmail.com", "hey.com", "aol.com", "gmx.com", "zoho.com",
]);

function titleCase(value: string): string {
  if (!value) return "Team";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function suggestedTeamName(email: string, displayName?: string): string {
  const [local, domain] = email.trim().toLowerCase().split("@");
  if (!local) return "";
  if (domain && domain.includes(".") && !PERSONAL_DOMAINS.has(domain)) {
    return titleCase(domain.split(".")[0] ?? domain);
  }
  const person = (displayName ?? "").trim();
  if (person) return `${person.split(/\s+/)[0]}'s team`;
  return `${titleCase(local)}'s team`;
}
