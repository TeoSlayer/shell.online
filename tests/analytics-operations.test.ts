import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_OPERATIONS, RELAY_OPERATIONS, apiOperation, relayOperation, httpOutcome, terminalCloseOutcome } from "../shared/analytics-operations";
import { posthogPayload } from "../shared/posthog";
import { analyticsRoute } from "../web/posthog";
import { DOCUMENTATION_KINDS } from "../shared/documentation";

describe("maintained feature and service coverage", () => {
  it("covers every app page and guide, excluding redirects and sensitive OAuth callback URLs", () => {
    const source = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");
    const routes = [...source.matchAll(/path="([^"]+)"/g)].map(([, path]) => path);
    expect(routes.length).toBeGreaterThan(12);
    for (const path of routes) {
      if (["/", "*", "/auth/callback"].includes(path)) continue;
      expect(analyticsRoute(new URL(`https://app.shell.online${path.replace(/:[A-Za-z]+/g, "PRIVATE_ID")}`)), path).not.toBeNull();
    }
    for (const guide of DOCUMENTATION_KINDS) {
      for (const path of [`/${guide}`, `/docs/v0.23.0${guide === "docs" ? "" : `/${guide}`}`]) {
        const route = analyticsRoute(new URL(`https://shell.online${path}`));
        expect(route?.guide, guide).toBe(guide);
        expect(posthogPayload("$pageview", "00000000-0000-4000-8000-000000000002", route ?? {})?.properties.$pathname).toBe(`/${guide}`);
      }
    }
    expect(analyticsRoute(new URL("https://app.shell.online/auth/callback?code=PRIVATE_CODE"))).toBeNull();
  });
  it("deploys the app when any shared analytics dependency changes", () => {
    const workflow = readFileSync(new URL("../.github/workflows/deploy-app.yml", import.meta.url), "utf8");
    for (const path of ["shared/posthog.ts", "shared/analytics-operations.ts", "shared/documentation.ts", "shared/public-attribution.ts", "web/posthog.ts"]) expect(workflow).toContain(`- "${path}"`);
  });
  it("classifies every literal API route in the actual account router", () => {
    const source = readFileSync(new URL("../app/server/app.ts", import.meta.url), "utf8");
    const routes = [...source.matchAll(/route === "(GET|POST|PUT|PATCH|DELETE) ([^"]+)"/g)];
    expect(routes.length).toBeGreaterThan(40);
    for (const [, method, path] of routes) expect(apiOperation(path, method), `${method} ${path}`).not.toBeNull();
  });
  it.each(API_OPERATIONS)("has a unique bounded operation name: %s", (name) => {
    expect(name).toMatch(/^[a-z_]{1,40}$/);
    expect(API_OPERATIONS.filter(([key]) => key === name)).toHaveLength(1);
  });
  it("classifies dynamic routes without transmitting secrets, URLs, IDs or content", () => {
    const secret = "SECRET_TOKEN_PASSWORD_CONTENT";
    for (const [path, method, expected] of [
      [`/api/sessions/${secret}/content?token=${secret}`, "GET", "session_content_read"],
      [`/api/sessions/${secret}/mcp/team/${secret}`, "DELETE", "mcp_team_grants"],
      [`/api/cli/sessions/${secret}/mcp/team-requests/${secret}/grant`, "POST", "mcp_team_host"],
      [`/api/agent/commands/${secret}`, "POST", "command_receipt"],
      [`/api/game/sessions/${secret}/assess`, "POST", "jev_assess"],
      [`/api/audit/${secret}`, "GET", "audit_read"],
    ]) {
      const operation = apiOperation(path, method);
      expect(operation).toBe(expected);
      const payload = posthogPayload("service_request", "00000000-0000-4000-8000-000000000002", {
        operation, method, service: "accounts", outcome: "ok", elapsed_ms: 42,
        path, token: secret, headers: { Authorization: secret }, result: secret, session_id: secret,
      });
      expect(payload?.properties).toMatchObject({ operation: expected, service: "accounts", elapsed_ms: 42 });
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(payload?.properties).not.toHaveProperty("$session_id");
      expect(payload?.properties).not.toHaveProperty("$current_url");
    }
  });
  it("fails closed on unrecognized or invalid dimensions and preserves meaningful failures", () => {
    for (const path of ["https://app.shell.online/api/vault", "/api/unknown/SECRET", `/api/${"x".repeat(4096)}`]) expect(apiOperation(path, "GET")).toBeNull();
    expect(apiOperation("/api/vault", "OPTIONS")).toBeNull();
    expect([200, 403, 429, 504, 503, 500].map(httpOutcome)).toEqual(["ok", "denied", "limited", "timeout", "unavailable", "failed"]);
    expect([4003, 4004, 4005, 4000, 1000, 1006].map(terminalCloseOutcome)).toEqual(["denied", "unavailable", "limited", "ended", "cancelled", "disconnected"]);
    const p = posthogPayload("feature_result", "00000000-0000-4000-8000-000000000002", { operation: "SECRET", outcome: "SECRET", elapsed_ms: Infinity, tool: "SECRET" });
    expect(JSON.stringify(p)).not.toContain("SECRET");
    expect(p?.properties).not.toHaveProperty("elapsed_ms");
  });
  it("separates relay transport, management, websocket admission and API telemetry", () => {
    const id = "a".repeat(32);
    expect(relayOperation("/mcp?PRIVATE", "POST")).toBe("mcp_transport");
    expect(relayOperation(`/api/sessions/${id}/mcp/grants`, "DELETE")).toBe("mcp_grant_manage");
    expect(relayOperation(`/api/sessions/${id}/ws?host_token=PRIVATE`, "GET")).toBe("relay_websocket");
    expect(relayOperation("/api/events", "POST")).toBeNull(); // don't re-track analytics ingestion
    expect(relayOperation("/api/UNKNOWN", "GET")).toBeNull();
    expect(httpOutcome(101)).toBe("ok");
    expect(new Set(RELAY_OPERATIONS.map(([name]) => name)).size).toBe(RELAY_OPERATIONS.length);
  });
});
