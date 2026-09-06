import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Store } from "./lib/store";
import { createVerifier, type VerifyResult } from "./lib/firebase-token";
import { exchangeCode, issueCode } from "./lib/codes";
import {
  checkAccessToken,
  issueTokens,
  refreshAccessToken,
  revokeByRefreshToken,
} from "./lib/tokens";
import { isValidRedirectUri } from "./lib/redirect";
import { closeSession, listSessions, registerSession } from "./lib/sessions";
import { mintSecret } from "./lib/tokens";

export interface AppOptions {
  store: Store;
  verifyIdToken: (token: string) => Promise<VerifyResult>;
  allowedOrigins: string[];
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function createApp(options: AppOptions) {
  const { store, verifyIdToken, allowedOrigins } = options;

  function send(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(payload);
  }

  function applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }
  }

  /* The web app authenticates with a Firebase ID token. */
  async function requireUser(request: IncomingMessage) {
    const result = await verifyIdToken(bearer(request));
    return result.ok ? result.identity : null;
  }

  /* The CLI authenticates with an opaque access token issued by this service. */
  function requireCli(request: IncomingMessage) {
    const check = checkAccessToken(store, bearer(request));
    return check.ok ? check.token : null;
  }

  return async function handle(request: IncomingMessage, response: ServerResponse) {
    applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${url.pathname}`;
    store.purgeExpired();

    try {
      /* ---- Approve a pending CLI login. Called by the web app. ---- */
      if (route === "POST /api/cli/authorize") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });

        const body = (await readBody(request)) as Record<string, unknown>;
        const redirectUri = String(body.redirect_uri ?? "");
        const codeChallenge = String(body.code_challenge ?? "");
        if (!isValidRedirectUri(redirectUri)) {
          return send(response, 400, { error: "redirect_uri must be a loopback callback" });
        }
        if (String(body.code_challenge_method ?? "") !== "S256") {
          return send(response, 400, { error: "code_challenge_method must be S256" });
        }
        if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
          return send(response, 400, { error: "invalid code_challenge" });
        }

        const code = issueCode(store, {
          uid: identity.uid,
          email: identity.email,
          name: identity.name,
          codeChallenge,
          redirectUri,
        });
        return send(response, 200, { code });
      }

      /* ---- Exchange the one-time code for CLI tokens. Called by the CLI. ---- */
      if (route === "POST /api/cli/token") {
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = exchangeCode(store, {
          code: String(body.code ?? ""),
          verifier: String(body.code_verifier ?? ""),
          redirectUri: String(body.redirect_uri ?? ""),
        });
        if (!result.ok) {
          return send(response, 400, { error: `authorization code ${result.reason}` });
        }
        const tokens = issueTokens(store, {
          uid: result.uid,
          email: result.email,
          name: result.name,
          label: String(body.label ?? "shell cli").slice(0, 80),
        });
        return send(response, 200, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresIn,
          account: { uid: result.uid, email: result.email, name: result.name },
        });
      }

      if (route === "POST /api/cli/refresh") {
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = refreshAccessToken(store, String(body.refresh_token ?? ""));
        if (!result.ok) return send(response, 401, { error: `refresh token ${result.reason}` });
        return send(response, 200, {
          access_token: result.accessToken,
          expires_in: result.expiresIn,
          account: {
            uid: result.token.uid,
            email: result.token.email,
            name: result.token.name,
          },
        });
      }

      if (route === "POST /api/cli/revoke") {
        const body = (await readBody(request)) as Record<string, unknown>;
        const revoked = revokeByRefreshToken(store, String(body.refresh_token ?? ""));
        return send(response, 200, { revoked });
      }

      if (route === "GET /api/cli/me") {
        const token = requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        return send(response, 200, {
          account: { uid: token.uid, email: token.email, name: token.name },
          label: token.label,
        });
      }

      /* ---- Session registry ---- */
      if (route === "POST /api/sessions") {
        const token = requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = registerSession(store, token.uid, {
          id: String(body.id ?? ""),
          shareUrl: String(body.share_url ?? ""),
          command: String(body.command ?? ""),
          readOnly: Boolean(body.read_only),
          encrypted: Boolean(body.encrypted),
          persistent: Boolean(body.persistent),
          host: typeof body.host === "string" ? body.host : "",
          name: typeof body.name === "string" ? body.name : undefined,
          startedAt: typeof body.started_at === "number" ? body.started_at : undefined,
        });
        if (!result.ok) return send(response, 400, { error: result.reason });
        return send(response, 201, { session: result.session });
      }

      const closeMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})$/);
      if (request.method === "PATCH" && closeMatch) {
        const token = requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const exitCode = typeof body.exit_code === "number" ? body.exit_code : undefined;
        const session = closeSession(store, token.uid, closeMatch[1], exitCode);
        if (!session) return send(response, 404, { error: "no such session" });
        return send(response, 200, { session });
      }

      /* ---- Linked machines ---- */
      if (route === "GET /api/devices") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { devices: store.listDevices(identity.uid) });
      }

      const deviceMatch = url.pathname.match(/^\/api\/devices\/(dev_[A-Za-z0-9_-]{1,64})$/);
      if (request.method === "DELETE" && deviceMatch) {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        /*
         * Scoped by uid inside the store, so a guessed id cannot unlink a
         * machine belonging to another account.
         */
        const revoked = store.revokeDevice(identity.uid, deviceMatch[1]);
        if (!revoked) return send(response, 404, { error: "no such machine" });
        return send(response, 200, { revoked: true });
      }

      if (route === "GET /api/sessions") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { sessions: listSessions(store, identity.uid) });
      }

      /* ---- Driving a machine from the browser ---- */

      /*
       * Queues work for a machine. The machine only ever sees it while its
       * owner is running `shell agent` there, which is the opt-in.
       */
      if (route === "POST /api/commands") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });

        const body = (await readBody(request)) as Record<string, unknown>;
        const deviceId = String(body.device_id ?? "");
        const kind = String(body.kind ?? "");

        const device = store.listDevices(identity.uid).find((entry) => entry.id === deviceId);
        if (!device) return send(response, 404, { error: "no such machine" });

        if (kind === "start") {
          const command = String(body.command ?? "").trim();
          if (!command) return send(response, 400, { error: "give a command to run" });
          if (command.length > 500) return send(response, 400, { error: "that command is too long" });
          const name = String(body.name ?? "").trim().slice(0, 120);
          const queued = {
            id: mintSecret("cmd"),
            uid: identity.uid,
            deviceId,
            kind: "start" as const,
            command,
            name: name || undefined,
            createdAt: Date.now(),
          };
          store.putCommand(queued);
          return send(response, 202, { command: queued });
        }

        if (kind === "kill") {
          const sessionId = String(body.session_id ?? "");
          /* Scoped by uid, so one account cannot stop another's session. */
          const owned = listSessions(store, identity.uid).some((s) => s.id === sessionId);
          if (!owned) return send(response, 404, { error: "no such session" });
          const queued = {
            id: mintSecret("cmd"),
            uid: identity.uid,
            deviceId,
            kind: "kill" as const,
            sessionId,
            createdAt: Date.now(),
          };
          store.putCommand(queued);
          return send(response, 202, { command: queued });
        }

        return send(response, 400, { error: "unknown command kind" });
      }

      /* ---- The agent side, authenticated as the machine ---- */
      if (route === "GET /api/agent/commands") {
        const token = requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        return send(response, 200, { commands: store.claimCommands(token.id) });
      }

      const doneMatch = url.pathname.match(/^\/api\/agent\/commands\/(cmd_[A-Za-z0-9_-]{1,128})$/);
      if (request.method === "POST" && doneMatch) {
        const token = requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const error = typeof body.error === "string" && body.error ? body.error : undefined;
        const finished = store.finishCommand(token.id, doneMatch[1], error);
        if (!finished) return send(response, 404, { error: "no such command" });
        return send(response, 200, { ok: true });
      }

      if (route === "GET /api/commands") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { commands: store.listCommands(identity.uid) });
      }

      if (route === "GET /api/health") {
        return send(response, 200, { ok: true });
      }

      return send(response, 404, { error: "no such route" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unexpected error";
      return send(response, 400, { error: message });
    }
  };
}

export function createAccountsServer(options: AppOptions) {
  return createServer(createApp(options));
}
