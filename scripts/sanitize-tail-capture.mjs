// Sanitized capture for `wrangler tail`. Reads the tail's JSON event stream from stdin and writes
// ONLY allowlisted, redaction-safe fields to stdout (one JSON line per trace event), as soon as
// each complete event arrives. Everything else — request headers (which carry the MCP bearer),
// URLs, other logs — is dropped BEFORE anything reaches disk or the terminal. A trace line is
// written only if it matches the strict allowlist format, so a malformed line can never smuggle
// identifiers or content into the capture.
//
// Usage: npx wrangler tail --config wrangler.staging.jsonc | node ./scripts/sanitize-tail-capture.mjs > capture.jsonl

const TRACE_PREFIX = "mcp_settle_trace ";
// The exact format the (redacted) settlement trace may emit: event + its single metadata field +
// ts. Identifiers (session/grant ids), terminal content, and credentials are NOT in the format.
const TRACE_ALLOWLIST =
  /^mcp_settle_trace event=(admitted timeout_ms=\d+|registered pending=\d+|settled reason=(?:matched|timeout|cancelled|reset) pending=\d+) ts=\d+$/;

// Split a stream of concatenated top-level JSON objects. Returns the complete objects plus the
// trailing incomplete fragment (rest) so a streaming caller can keep it for the next chunk.
// Brace-depth tracking respects string literals and escapes.
export function extractTopLevelObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return { objects, rest: start !== -1 ? text.slice(start) : "" };
}

// Complete top-level objects in a full (non-streaming) text.
export function splitTopLevelObjects(text) {
  return extractTopLevelObjects(text).objects;
}

// Sanitize parsed tail events: return the allowlisted output lines (JSON strings), one per trace
// event. Non-allowlisted content is never echoed.
export function sanitizeObjects(objects) {
  const out = [];
  for (const chunk of objects) {
    let event;
    try {
      event = JSON.parse(chunk);
    } catch {
      continue; // a malformed chunk is dropped, never echoed
    }
    const logs = Array.isArray(event?.logs) ? event.logs : [];
    for (const log of logs) {
      const messages = Array.isArray(log?.message) ? log.message : [];
      for (const message of messages) {
        if (typeof message === "string" && message.startsWith(TRACE_PREFIX) && TRACE_ALLOWLIST.test(message)) {
          out.push(JSON.stringify({ ts: typeof log.timestamp === "number" ? log.timestamp : null, trace: message }));
        }
      }
    }
  }
  return out;
}

// Sanitize a full tail stream: return the allowlisted output lines, one per trace event.
export function sanitizeTailStream(text) {
  return sanitizeObjects(splitTopLevelObjects(text));
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let buffer = "";
  const flush = (text) => {
    const { objects, rest } = extractTopLevelObjects(text);
    buffer = rest;
    for (const line of sanitizeObjects(objects)) {
      process.stdout.write(line + "\n");
    }
  };
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    flush(buffer);
  });
  process.stdin.on("end", () => {
    flush(buffer);
  });
}
