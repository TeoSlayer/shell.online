/*
 * Which accounts are ours rather than a customer's.
 *
 * The statistics dashboard is read to answer one question -- how is the
 * product doing -- and our own accounts answer it wrongly. Founders,
 * colleagues, the addresses the end-to-end tests sign up with and the people
 * who build the thing are the most active accounts there are, and they were
 * always going to use it. Left in, they make a quiet week look like a good
 * one. So they are taken out of every account figure, and the dashboard says
 * how many it took out rather than quietly showing a smaller number.
 *
 * The list is configuration, not source. It names individual people, and this
 * repository is public: STATS_EXCLUDE carries it, and an unset variable
 * excludes nobody.
 */

/**
 * Reads the list. Entries are separated by commas, semicolons or whitespace,
 * so a value can be pasted in whichever shape it was written in.
 *
 * Each entry is either a whole address (`someone@example.com`) or a domain
 * (`example.com` or `@example.com`), which also covers its subdomains.
 */
export function parseExcludedAccounts(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether this address is one of ours.
 *
 * A `+tag` is dropped from both sides before comparing: every mail provider
 * we use delivers `name+anything@` to `name@`, so a rule that did not would
 * be walked around by the first person who signed up with a tagged address.
 */
export function isExcludedAccount(rules: readonly string[], email: string | undefined): boolean {
  const address = normalizeAddress(email);
  if (address === "") return false;
  const domain = address.slice(address.indexOf("@") + 1);
  return rules.some((rule) => {
    if (rule.includes("@") && !rule.startsWith("@")) return normalizeAddress(rule) === address;
    const suffix = rule.startsWith("@") ? rule.slice(1) : rule;
    return suffix !== "" && (domain === suffix || domain.endsWith(`.${suffix}`));
  });
}

/** The predicate the stores tag rows with, so a caller never handles an address. */
export function excludedAccountFilter(rules: readonly string[]): (email: string) => boolean {
  if (rules.length === 0) return () => false;
  return (email) => isExcludedAccount(rules, email);
}

function normalizeAddress(email: string | undefined): string {
  const address = (email ?? "").trim().toLowerCase();
  const at = address.indexOf("@");
  if (at <= 0 || at === address.length - 1) return "";
  const local = address.slice(0, at);
  const tag = local.indexOf("+");
  return `${tag === -1 ? local : local.slice(0, tag)}@${address.slice(at + 1)}`;
}
