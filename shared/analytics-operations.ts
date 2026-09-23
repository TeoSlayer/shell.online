/** Maintained operation inventory. Only these fixed names can leave the process.
 * Paths are classified locally; no path segment, query, method body or result is captured.
 * An API success means the API answered successfully, NOT that an agent finished work.
 */
export const API_OPERATIONS = [
  ["health", "GET", /^\/api\/(?:health|ready)$/],
  ["cli_authorize", "POST", /^\/api\/cli\/authorize$/],
  ["cli_token", "POST", /^\/api\/cli\/(?:token|refresh|revoke)$/],
  ["cli_account", "GET", /^\/api\/cli\/me$/],
  ["session_list", "GET", /^\/api\/(?:cli\/)?sessions$/],
  ["briefing_preferences", "GET PUT", /^\/api\/cli\/briefings$/],
  ["mcp_activity_publish", "POST", /^\/api\/cli\/sessions\/[^/]+\/mcp-flows$/],
  ["mcp_activity_read", "GET", /^\/api\/game\/mcp-flows$/],
  ["jev_assessments", "GET", /^\/api\/game\/assessments$/],
  ["jev_consent", "PUT", /^\/api\/game\/assessments\/consent$/],
  ["jev_assess", "POST", /^\/api\/game\/sessions\/[^/]+\/assess$/],
  ["mcp_team_grants", "GET POST DELETE", /^\/api\/(?:cli\/)?sessions\/[^/]+\/mcp\/team(?:\/[^/]+)?$/],
  ["mcp_team_host", "GET POST", /^\/api\/cli\/sessions\/[^/]+\/mcp\/team-requests(?:\/[^/]+\/(?:grant|revoke-ack))?$/],
  ["mcp_team_authorize", "GET", /^\/api\/internal\/mcp\/team-authorized$/],
  ["session_content_publish", "PUT", /^\/api\/cli\/sessions\/[^/]+\/content$/],
  ["session_content_policy", "GET", /^\/api\/cli\/sessions\/[^/]+\/content-policy$/],
  ["session_content_read", "GET", /^\/api\/sessions\/[^/]+\/content$/],
  ["session_automation", "GET PUT", /^\/api\/(?:cli\/)?sessions\/[^/]+\/automation$/],
  ["team_read", "GET", /^\/api\/org$/],
  ["team_update", "PATCH", /^\/api\/org$/],
  ["invite_preview", "GET", /^\/api\/invites\/[^/]+$/],
  ["invite_create", "POST", /^\/api\/org\/invites$/],
  ["invite_revoke", "DELETE", /^\/api\/org\/invites\/[^/]+$/],
  ["member_update", "PATCH DELETE", /^\/api\/org\/members\/[^/]+$/],
  ["audit_record", "POST", /^\/api\/audit$/],
  ["audit_read", "GET", /^\/api\/audit(?:\/[^/]+)?$/],
  ["audit_export", "GET", /^\/api\/audit\.csv$/],
  ["audit_seal", "POST", /^\/api\/audit\/seal$/],
  ["game_read", "GET", /^\/api\/game(?:\/(?:stats|runs))?$/],
  ["game_profile", "PUT", /^\/api\/game$/],
  ["game_gather", "POST", /^\/api\/game\/gather$/],
  ["agent_stats", "POST", /^\/api\/agent\/stats$/],
  ["team_keys", "GET POST PUT DELETE", /^\/api\/team-key(?:\/(?:shares|share))?$/],
  ["vault_read", "GET", /^\/api\/vault$/],
  ["vault_save", "POST PATCH", /^\/api\/vault$/],
  ["account_key", "GET", /^\/api\/account\/key$/],
  ["account_delete", "DELETE", /^\/api\/account$/],
  ["session_register", "POST", /^\/api\/sessions$/],
  ["session_remove", "DELETE", /^\/api\/sessions\/[^/]+$/],
  ["session_close", "PATCH", /^\/api\/sessions\/[^/]+$/],
  ["session_detail", "GET", /^\/api\/sessions\/[^/]+$/],
  ["machine_list", "GET", /^\/api\/devices$/],
  ["machine_remove", "DELETE", /^\/api\/devices\/[^/]+$/],
  ["session_keys", "PUT", /^\/api\/sessions\/[^/]+\/keys$/],
  ["session_assign", "PUT", /^\/api\/sessions\/[^/]+\/assignee$/],
  ["session_rename", "PUT", /^\/api\/sessions\/[^/]+\/name$/],
  ["command_request", "POST", /^\/api\/commands$/],
  ["command_list", "GET", /^\/api\/commands$/],
  ["command_poll", "GET", /^\/api\/agent\/commands$/],
  ["command_receipt", "POST", /^\/api\/agent\/commands\/[^/]+$/],
  ["comment_create", "POST", /^\/api\/sessions\/[^/]+\/comments$/],
  ["feedback_submit", "POST", /^\/api\/feedback$/],
  ["account_stats", "GET", /^\/api\/stats\/accounts$/],
  ["inbox_read", "GET", /^\/api\/notifications$/],
  ["inbox_mark", "POST", /^\/api\/notifications\/read$/],
] as const;

export const FEATURE_OPERATIONS = [
  "vault_create", "vault_unlock_recovery", "vault_unlock_password", "vault_unlock_passkey",
  "vault_password", "vault_passkey", "vault_lock", "clipboard_copy", "inbox_open", "inbox_follow",
  "terminal_connect", "terminal_unlock", "terminal_renderer", "terminal_settings",
  "file_list", "file_preview", "file_download", "service_purge",
] as const;

export const RELAY_OPERATIONS = [
  ["relay_health", "GET", /^\/api\/health$/],
  ["repository_stats", "GET", /^\/api\/github$/],
  ["documentation_read", "GET", /^\/api\/docs\/(?:releases|content)$/],
  ["relay_stats", "GET POST", /^\/api\/stats(?:\/[^/]+)*$/],
  ["relay_session_create", "POST", /^\/api\/sessions$/],
  ["relay_session_resume", "POST", /^\/api\/sessions\/resume$/],
  ["relay_session_status", "GET", /^\/api\/sessions\/[A-Za-z0-9_-]{32}$/],
  ["relay_websocket", "GET", /^\/api\/sessions\/[A-Za-z0-9_-]{32}\/ws$/],
  ["mcp_transport", "POST", /^\/mcp$/],
  ["mcp_grant_manage", "POST DELETE GET", /^\/api\/sessions\/[A-Za-z0-9_-]{32}\/mcp\/grants?$/],
] as const;

export function relayOperation(path: string, method: string): string | null {
  if (path.length > 4096) return null;
  const pathname = path.split(/[?#]/, 1)[0];
  return RELAY_OPERATIONS.find(([, methods, route]) => methods.split(" ").includes(method) && route.test(pathname))?.[0] ?? null;
}

export const OPERATION_NAMES = new Set<string>([...API_OPERATIONS.map(([key]) => key), ...RELAY_OPERATIONS.map(([key]) => key), ...FEATURE_OPERATIONS]);
export const OPERATION_OUTCOMES = ["ok", "failed", "cancelled", "timeout", "denied", "limited", "unavailable", "disconnected", "ended", "network", "response", "signed_out"] as const;
export type OperationOutcome = typeof OPERATION_OUTCOMES[number];

export function apiOperation(path: string, method: string): string | null {
  // Reject absolute/oversized inputs rather than accidentally tracking arbitrary destinations.
  if (path.length > 4096 || !path.startsWith("/api/")) return null;
  const pathname = path.split(/[?#]/, 1)[0];
  return API_OPERATIONS.find(([, methods, route]) => methods.split(" ").includes(method) && route.test(pathname))?.[0] ?? null;
}

export function httpOutcome(status: number): OperationOutcome {
  return status === 101 || status >= 200 && status < 400 ? "ok" : status === 401 || status === 403 ? "denied" :
    status === 429 ? "limited" : status === 408 || status === 504 ? "timeout" :
    status === 404 || status === 410 || status === 503 ? "unavailable" : "failed";
}

/** Both viewers use identical finite categories, never a peer-supplied close reason. */
export function terminalCloseOutcome(code: number): OperationOutcome {
  return code === 4003 ? "denied" : code === 4004 ? "unavailable" :
    code === 4005 ? "limited" : code === 4000 ? "ended" : code === 1000 ? "cancelled" : "disconnected";
}
