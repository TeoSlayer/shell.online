// Runtime-neutral MCP grant-record model and validation.
//
// Used by the Worker/DO for grant management and per-request authorization. The Go CLI keeps
// its own copy; this module is the single source of truth for the Cloudflare side.
//
// Grants are run-bound, scoped, fixed-expiry, and non-renewing. The DO stores only this
// metadata (plus the SHA-256 of the bearer) — never the bearer or an E2EE key.

export type McpScope = "observe" | "input" | "interrupt";

export const MCP_SCOPES: readonly McpScope[] = ["observe", "input", "interrupt"];

export type McpScopeSet = "observe" | "control" | "controlInterrupt";

export interface McpGrantRecord {
  grantId: string;
  bearerHash: string;
  label: string;
  scopes: McpScope[];
  runId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  revokedAt: number | null;
}

const SCOPE_SET_KEY: Record<McpScopeSet, string> = {
  observe: "observe",
  control: "input,observe",
  controlInterrupt: "input,interrupt,observe",
};

export const DEFAULT_LIFETIME: Record<McpScopeSet, number> = {
  observe: 3600,
  control: 900,
  controlInterrupt: 900,
};

export const MAX_LIFETIME: Record<McpScopeSet, number> = {
  observe: 12 * 3600,
  control: 3600,
  controlInterrupt: 3600,
};

export const MAX_GRANTS_PER_RUN = 8;

// Map a canonical (deduped, sorted) scope list to its preset name, or null if it is not one of
// the three valid presets. This is the scope-set validator: `input` implies `observe`, and the
// only valid sets are observe / control / control+interrupt.
export function scopeSetKey(scopes: readonly McpScope[]): McpScopeSet | null {
  const key = [...scopes].sort().join(",");
  for (const [name, k] of Object.entries(SCOPE_SET_KEY)) {
    if (k === key) return name as McpScopeSet;
  }
  return null;
}

// Dedupe, sort, and validate a scope list against the three valid presets. Throws on an unknown
// scope or an invalid combination (e.g. `input` without `observe`).
export function validateScopes(scopes: readonly McpScope[]): McpScope[] {
  const seen = new Set<McpScope>();
  for (const s of scopes) {
    if (!MCP_SCOPES.includes(s)) throw new Error(`unknown scope: ${String(s)}`);
    seen.add(s);
  }
  const canonical = [...seen].sort();
  if (scopeSetKey(canonical) === null) {
    throw new Error(`invalid scope set: ${canonical.join(",")}`);
  }
  return canonical;
}

// Clamp a requested lifetime (seconds, or null for the preset default) to [1, min(preset hard
// max, remaining run/session lifetime)]. `ceiling` is the run/session expiry (unix seconds).
export function clampLifetime(
  requested: number | null,
  scopes: readonly McpScope[],
  now: number,
  ceiling: number,
): number {
  const preset = scopeSetKey(scopes);
  if (preset === null) throw new Error(`invalid scope set: ${[...scopes].join(",")}`);
  const remaining = Math.floor(ceiling - now);
  if (remaining < 1) throw new Error("run/session already expired");
  const hardMax = Math.min(MAX_LIFETIME[preset], remaining);
  const base = requested === null || Number.isNaN(requested) ? DEFAULT_LIFETIME[preset] : requested;
  return Math.min(Math.max(1, Math.floor(base)), hardMax);
}

// Sanitize an operator label: strip C0 control chars + DEL, collapse whitespace runs, trim, and
// bound the length.
export function sanitizeLabel(label: string, maxLen = 64): string {
  return label
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function isLive(g: McpGrantRecord, now: number): boolean {
  return !g.revoked && now < g.expiresAt;
}

// A grant is valid for a request only if it is live AND bound to the current run. This is the
// single enforcement predicate the DO uses for both admission (findLiveGrant) and the
// pre-execution recheck, so a revoked/expired grant or a grant from a superseded run is rejected.
export function isGrantLiveForRun(g: McpGrantRecord, runId: string, now: number): boolean {
  return isLive(g, now) && g.runId === runId;
}

export function hasScope(g: McpGrantRecord, scope: McpScope): boolean {
  return g.scopes.includes(scope);
}

export function liveCount(grants: readonly McpGrantRecord[], runId: string, now: number): number {
  return grants.filter((g) => g.runId === runId && isLive(g, now)).length;
}

// Non-live (revoked/expired) records are retained briefly — most recent first — so in-flight
// cancellation and `list` stay meaningful, then pruned. This is separate from the 8-live-grant
// quota (which bounds only live grants) and stops repeated create/revoke cycles from growing
// storage, authorization scans, and list responses without bound.
export const MAX_RETAINED_NONLIVE_GRANTS = 8;

export function pruneGrantRecords(
  grants: readonly McpGrantRecord[],
  runId: string,
  now: number,
): McpGrantRecord[] {
  const currentRun = grants.filter((g) => g.runId === runId);
  const live = currentRun.filter((g) => isLive(g, now));
  const nonLive = currentRun
    .filter((g) => !isLive(g, now))
    .sort((a, b) => b.createdAt - a.createdAt);
  return [...live, ...nonLive.slice(0, MAX_RETAINED_NONLIVE_GRANTS)];
}

export function createGrantRecord(opts: {
  grantId: string;
  bearerHash: string;
  label: string;
  scopes: readonly McpScope[];
  runId: string;
  now: number;
  lifetime: number;
}): McpGrantRecord {
  const canonical = validateScopes(opts.scopes);
  if (!Number.isFinite(opts.lifetime) || opts.lifetime < 1) {
    throw new Error("lifetime must be a finite number >= 1s");
  }
  return {
    grantId: opts.grantId,
    bearerHash: opts.bearerHash,
    label: sanitizeLabel(opts.label),
    scopes: canonical,
    runId: opts.runId,
    createdAt: opts.now,
    expiresAt: opts.now + Math.floor(opts.lifetime),
    revoked: false,
    revokedAt: null,
  };
}
