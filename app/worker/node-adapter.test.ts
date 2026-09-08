import { describe, expect, it } from "vitest";
import { callNodeHandler, type NodeHandler } from "./node-adapter";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/lib/store-memory";
import type { VerifyResult } from "../server/lib/firebase-token";

const ORIGIN = "http://localhost:5173";

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  forwarded: string | null;
  address: string | null;
  body: string | null;
}

async function seenBy(response: Response): Promise<Seen> {
  return (await response.json()) as Seen;
}

/*
 * Reports what the router would have seen. Consuming the body the way readBody
 * does is the part worth copying: listeners registered synchronously, "data"
 * before "end", nothing awaited in between.
 */
const echo: NodeHandler = async (request, response) => {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", resolve);
    request.on("error", reject);
  });
  response.setHeader("X-Probe", "yes");
  response.writeHead(201, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      forwarded: request.headers["x-forwarded-for"] ?? null,
      address: request.socket?.remoteAddress ?? null,
      body: chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8"),
    }),
  );
};

/* The real router, so the response side is checked against its actual output. */
function router() {
  const verifyIdToken = async (): Promise<VerifyResult> => ({ ok: false, reason: "no token" });
  return createApp({
    store: MemoryStore.memory(),
    verifyIdToken,
    allowedOrigins: [ORIGIN],
    log: () => {},
  });
}

describe("callNodeHandler", () => {
  it("carries the method and the path through", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/sessions/abc", { method: "PATCH", body: "{}" }),
      echo,
    );
    const seen = await seenBy(response);
    expect(seen.method).toBe("PATCH");
    expect(seen.url).toBe("/api/sessions/abc");
  });

  it("keeps the query string, which the router routes on", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/agent/commands?key=abc&harnesses=codex%2Chermes"),
      echo,
    );
    expect((await seenBy(response)).url).toBe("/api/agent/commands?key=abc&harnesses=codex%2Chermes");
  });

  it("makes headers readable under the names node lowercases them to", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/cli/me", {
        headers: { Authorization: "Bearer sha_1", "X-Forwarded-For": "198.51.100.4" },
      }),
      echo,
    );
    const seen = await seenBy(response);
    expect(seen.authorization).toBe("Bearer sha_1");
    expect(seen.forwarded).toBe("198.51.100.4");
  });

  it("takes the caller's address from CF-Connecting-IP", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/health", { headers: { "CF-Connecting-IP": "203.0.113.7" } }),
      echo,
    );
    expect((await seenBy(response)).address).toBe("203.0.113.7");
  });

  it("reports no address when the edge did not name one", async () => {
    const response = await callNodeHandler(new Request("https://app.example/api/health"), echo);
    expect((await seenBy(response)).address).toBeNull();
  });

  it("delivers the request body, and delivers nothing at all when there is none", async () => {
    const withBody = await callNodeHandler(
      new Request("https://app.example/api/probe", { method: "POST", body: '{"entries":[]}' }),
      echo,
    );
    expect((await seenBy(withBody)).body).toBe('{"entries":[]}');

    /* No chunks rather than an empty one: that is how readBody tells the
       difference between an absent body and a broken one. */
    const without = await callNodeHandler(new Request("https://app.example/api/health"), echo);
    expect((await seenBy(without)).body).toBeNull();
  });

  it("returns the status and the headers the handler set both ways", async () => {
    const response = await callNodeHandler(new Request("https://app.example/api/health"), echo);
    expect(response.status).toBe(201);
    /* setHeader before writeHead, and both have to survive. */
    expect(response.headers.get("X-Probe")).toBe("yes");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("callNodeHandler with the real router", () => {
  it("answers a route the router owns", async () => {
    const response = await callNodeHandler(new Request("https://app.example/api/health"), router());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns the CORS headers the router sets with setHeader", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/health", { headers: { Origin: ORIGIN } }),
      router(),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("answers a preflight with no body", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/org", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      router(),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("hands a JSON body to readBody", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/cli/token", {
        method: "POST",
        body: JSON.stringify({ code: "shc_nope", code_verifier: "v", redirect_uri: "http://127.0.0.1:1/cb" }),
      }),
      router(),
    );
    /* Reaching this refusal means the fields were parsed out of the body. */
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/^authorization code /);
  });

  it("lets readBody refuse a body that is not JSON", async () => {
    const response = await callNodeHandler(
      new Request("https://app.example/api/cli/token", { method: "POST", body: "not json" }),
      router(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body is not valid JSON" });
  });

  it("rate limits per CF-Connecting-IP rather than per request", async () => {
    const handle = router();
    const call = (address: string) =>
      callNodeHandler(
        new Request("https://app.example/api/cli/token", {
          method: "POST",
          body: "{}",
          headers: { "CF-Connecting-IP": address },
        }),
        handle,
      );

    /* The credential bucket holds twelve. */
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await call("203.0.113.7")).status).toBe(400);
    }
    const refused = await call("203.0.113.7");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();

    /* A different caller has its own bucket, which it only can if the address
       reached the limiter. */
    expect((await call("203.0.113.8")).status).toBe(400);
  });
});
