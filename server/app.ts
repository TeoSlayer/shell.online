import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Store } from "./lib/store";
import type { VerifyResult } from "./lib/firebase-token";
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
import {
  changeRole,
  createInvite,
  describeOrganization,
  ensureMembership,
  previewInvite,
  removeMember,
  renameOrganization,
  revokeInvite,
} from "./routes/organizations";
import { assignSession, auditCsv, recordAudit } from "./routes/audit";
import { addComment, inbox, notifyAssigned, notifySessionStarted } from "./routes/social";

export interface AppOptions {
  store: Store;
  verifyIdToken: (token: string) => Promise<VerifyResult>;
  allowedOrigins: string[];
}

const MAX_BODY_BYTES = 64 * 1024;

/* An agent polls every 2s, so this is generous enough to survive a hiccup. */
export const AGENT_ONLINE_MS = 15_000;

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
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
  }

  /* The web app authenticates with a Firebase ID token. */
  async function requireUser(request: IncomingMessage) {
    const result = await verifyIdToken(bearer(request));
    return result.ok ? result.identity : null;
  }

  /*
   * Resolves who is calling and which organization they are in, creating one
   * on first sight. Every signed-in route goes through this, so there is no
   * path that leaves an account without an organization.
   */
  async function requireMember(request: IncomingMessage, inviteId?: string) {
    const identity = await requireUser(request);
    if (!identity) return null;
    return (await ensureMembership(store, identity, inviteId)).membership;
  }

  /* The CLI authenticates with an opaque access token issued by this service. */
  async function requireCli(request: IncomingMessage) {
    const check = await checkAccessToken(store, bearer(request));
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
    await store.purgeExpired();

    try {
      /* ---- Approve a pending CLI login. Called by the web app. ---- */
      if (route === "POST /api/cli/authorize") {
        /*
         * Approving a machine establishes the organization if it does not
         * exist yet, so every token this issues belongs to one and the
         * sessions it publishes are visible to colleagues.
         */
        const identity = await requireMember(request);
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

        const code = await issueCode(store, {
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
        const result = await exchangeCode(store, {
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
        const result = await refreshAccessToken(store, String(body.refresh_token ?? ""));
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
        const revoked = await revokeByRefreshToken(store, String(body.refresh_token ?? ""));
        return send(response, 200, { revoked });
      }

      if (route === "GET /api/cli/me") {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        return send(response, 200, {
          account: { uid: token.uid, email: token.email, name: token.name },
          label: token.label,
        });
      }

      /* ---- Organization ---- */

      if (route === "GET /api/org") {
        const invite = url.searchParams.get("invite") ?? undefined;
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        const resolved = await ensureMembership(store, identity, invite);
        /* Publishing the browser key here keeps it current without a
           separate call on every sign-in. */
        const publicKey = url.searchParams.get("key");
        if (publicKey) await store.setMemberKey(identity.uid, publicKey);
        const described = await describeOrganization(store, resolved.membership);
        return send(response, described.status, {
          ...(described.body as Record<string, unknown>),
          joined: resolved.joined,
          inviteError: resolved.error,
        });
      }

      if (route === "PATCH /api/org") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await renameOrganization(store, membership, String(body.name ?? ""));
        return send(response, result.status, result.body);
      }

      /* Readable before signing in, so an invite link can say what it is. */
      const invitePreview = url.pathname.match(/^\/api\/invites\/(inv_[a-f0-9]{32})$/);
      if (request.method === "GET" && invitePreview) {
        const result = await previewInvite(store, invitePreview[1]);
        return send(response, result.status, result.body);
      }

      if (route === "POST /api/org/invites") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await createInvite(store, membership, {
          role: typeof body.role === "string" ? body.role : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
        });
        return send(response, result.status, result.body);
      }

      const inviteRoute = url.pathname.match(/^\/api\/org\/invites\/(inv_[a-f0-9]{32})$/);
      if (request.method === "DELETE" && inviteRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const result = await revokeInvite(store, membership, inviteRoute[1]);
        return send(response, result.status, result.body);
      }

      const memberRoute = url.pathname.match(/^\/api\/org\/members\/([A-Za-z0-9_-]{1,128})$/);
      if (request.method === "DELETE" && memberRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const result = await removeMember(store, membership, memberRoute[1]);
        return send(response, result.status, result.body);
      }
      if (request.method === "PATCH" && memberRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await changeRole(store, membership, memberRoute[1], String(body.role ?? ""));
        return send(response, result.status, result.body);
      }

      /* ---- Audit ---- */

      if (route === "POST /api/audit") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const entries = Array.isArray(body.entries) ? body.entries : [];
        const written = [];
        for (const entry of entries.slice(0, 100)) {
          const candidate = entry as Record<string, unknown>;
          const result = await recordAudit(store, membership, {
            sessionId: String(candidate.session_id ?? ""),
            kind: String(candidate.kind ?? "input"),
            text: String(candidate.text ?? ""),
            at: typeof candidate.at === "number" ? candidate.at : undefined,
          });
          if (result.ok) written.push(result.event);
        }
        return send(response, 200, { written: written.length });
      }

      const auditRoute = url.pathname.match(/^\/api\/audit\/([A-Za-z0-9_-]{6,64})$/);
      if (request.method === "GET" && auditRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        if (!await store.sessionInOrg(membership.orgId, auditRoute[1])) {
          return send(response, 404, { error: "no such session" });
        }
        return send(response, 200, { events: await store.auditFor(membership.orgId, auditRoute[1]) });
      }

      if (route === "GET /api/audit.csv") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const sessionId = url.searchParams.get("session");
        const events = sessionId
          ? await store.auditFor(membership.orgId, sessionId)
          : await store.auditForOrg(membership.orgId);
        const csv = auditCsv(events, await store.listOrgSessions(membership.orgId));
        response.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="shell-online-audit.csv"`,
          "Cache-Control": "no-store",
        });
        response.end(csv);
        return;
      }

      /* ---- Session registry ---- */
      if (route === "POST /api/sessions") {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const membership = await store.membershipOf(token.uid);
        const result = await registerSession(store, token.uid, {
          id: String(body.id ?? ""),
          shareUrl: String(body.share_url ?? ""),
          command: String(body.command ?? ""),
          readOnly: Boolean(body.read_only),
          encrypted: Boolean(body.encrypted),
          persistent: Boolean(body.persistent),
          host: typeof body.host === "string" ? body.host : "",
          name: typeof body.name === "string" ? body.name : undefined,
          origin: typeof body.origin === "string" ? body.origin : undefined,
          startedAt: typeof body.started_at === "number" ? body.started_at : undefined,
          /* Colleagues see this session because it belongs to the org. */
          orgId: membership?.orgId,
          ownerUid: token.uid,
        });
        if (!result.ok) return send(response, 400, { error: result.reason });
        /* Only on first sight, so a persistent session restarting is silent. */
        if (result.isNew && membership) {
          await notifySessionStarted(
            store,
            membership.orgId,
            token.uid,
            result.session.id,
            result.session.name || result.session.command,
          );
        }
        return send(response, 201, { session: result.session });
      }

      const closeMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})$/);
      if (request.method === "PATCH" && closeMatch) {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const exitCode = typeof body.exit_code === "number" ? body.exit_code : undefined;
        const session = await closeSession(store, token.uid, closeMatch[1], exitCode);
        if (!session) return send(response, 404, { error: "no such session" });
        return send(response, 200, { session });
      }

      /* ---- Linked machines ---- */
      if (route === "GET /api/devices") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { devices: await store.listDevices(identity.uid) });
      }

      const deviceMatch = url.pathname.match(/^\/api\/devices\/(dev_[A-Za-z0-9_-]{1,64})$/);
      if (request.method === "DELETE" && deviceMatch) {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        /*
         * Scoped by uid inside the store, so a guessed id cannot unlink a
         * machine belonging to another account.
         */
        const revoked = await store.revokeDevice(identity.uid, deviceMatch[1]);
        if (!revoked) return send(response, 404, { error: "no such machine" });
        return send(response, 200, { revoked: true });
      }

      if (route === "GET /api/sessions") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        /* Everyone in the organization sees everyone's sessions. */
        /*
         * Each caller receives only the copy sealed to them. Handing out
         * everyone's would be pointless, since they cannot open them, and
         * would put more sealed material on the wire than anyone needs.
         */
        const sessions = (await store.listOrgSessions(membership.orgId)).map((session) => {
          const mine = session.keyShares?.find((share) => share.uid === membership.uid);
          return { ...session, keyShares: undefined, keyShare: mine };
        });
        return send(response, 200, {
          sessions,
          members: await store.members(membership.orgId),
          you: membership,
        });
      }

      const shareRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})\/keys$/);
      if (request.method === "PUT" && shareRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const incoming = Array.isArray(body.shares) ? body.shares : [];
        const shares = incoming
          .map((entry) => entry as Record<string, unknown>)
          .filter((entry) => typeof entry.uid === "string" && typeof entry.sealed === "string")
          .slice(0, 100)
          .map((entry) => ({
            uid: String(entry.uid),
            senderPublicKey: String(entry.sender_public_key ?? ""),
            sealed: String(entry.sealed),
          }));
        if (!await store.putKeyShares(membership.orgId, shareRoute[1], shares)) {
          return send(response, 404, { error: "no such session" });
        }
        return send(response, 200, { shared: shares.length });
      }

      const assignRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})\/assignee$/);
      if (request.method === "PUT" && assignRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await assignSession(store, membership, assignRoute[1], String(body.uid ?? ""));
        if (!result.ok) return send(response, result.status, { error: result.error });
        await notifyAssigned(
          store,
          membership,
          assignRoute[1],
          String(body.uid ?? ""),
          result.session.name || result.session.command,
        );
        return send(response, 200, { session: result.session });
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

        const device = (await store.listDevices(identity.uid)).find((entry) => entry.id === deviceId);
        if (!device) return send(response, 404, { error: "no such machine" });

        /*
         * Only a polling agent can carry work out. Queuing for a machine with
         * none would sit there silently forever, which is a worse answer than
         * saying so now.
         */
        if (!device.agentSeenAt || Date.now() - device.agentSeenAt > AGENT_ONLINE_MS) {
          return send(response, 409, {
            error: `No agent is listening on ${device.label}. Run 'shell agent' there and try again.`,
          });
        }

        if (kind === "start") {
          const command = String(body.command ?? "").trim();
          if (!command) return send(response, 400, { error: "give a command to run" });
          if (command.length > 500) return send(response, 400, { error: "that command is too long" });
          const name = String(body.name ?? "").trim().slice(0, 120);
          /*
           * Relayed verbatim. This service has no key for it and must not
           * pretend to validate what it cannot read.
           */
          const senderPublicKey = String(body.sender_public_key ?? "").slice(0, 200);
          const sealedPassword = String(body.sealed_password ?? "").slice(0, 400);
          const queued = {
            id: mintSecret("cmd"),
            uid: identity.uid,
            deviceId,
            kind: "start" as const,
            command,
            name: name || undefined,
            senderPublicKey: senderPublicKey || undefined,
            sealedPassword: sealedPassword || undefined,
            createdAt: Date.now(),
          };
          await store.putCommand(queued);
          return send(response, 202, { command: queued });
        }

        if (kind === "kill") {
          const sessionId = String(body.session_id ?? "");
          /* Scoped by uid, so one account cannot stop another's session. */
          const scope = await store.membershipOf(identity.uid);
          const owned = scope
            ? Boolean(await store.sessionInOrg(scope.orgId, sessionId))
            : (await listSessions(store, identity.uid)).some((s) => s.id === sessionId);
          if (!owned) return send(response, 404, { error: "no such session" });
          const queued = {
            id: mintSecret("cmd"),
            uid: identity.uid,
            deviceId,
            kind: "kill" as const,
            sessionId,
            createdAt: Date.now(),
          };
          await store.putCommand(queued);
          return send(response, 202, { command: queued });
        }

        return send(response, 400, { error: "unknown command kind" });
      }

      /* ---- The agent side, authenticated as the machine ---- */
      if (route === "GET /api/agent/commands") {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        /* The agent publishes its key on every poll, so a restart re-keys. */
        await store.markAgentSeen(token.id, url.searchParams.get("key") ?? undefined);
        return send(response, 200, { commands: await store.claimCommands(token.id) });
      }

      const doneMatch = url.pathname.match(/^\/api\/agent\/commands\/(cmd_[A-Za-z0-9_-]{1,128})$/);
      if (request.method === "POST" && doneMatch) {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const error = typeof body.error === "string" && body.error ? body.error : undefined;
        const finished = await store.finishCommand(token.id, doneMatch[1], error);
        if (!finished) return send(response, 404, { error: "no such command" });
        return send(response, 200, { ok: true });
      }

      if (route === "GET /api/commands") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { commands: await store.listCommands(identity.uid) });
      }

      /* ---- One session, in detail ---- */

      const oneSession = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})$/);
      if (request.method === "GET" && oneSession) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const session = await store.sessionInOrg(membership.orgId, oneSession[1]);
        if (!session) return send(response, 404, { error: "no such session" });
        const mine = session.keyShares?.find((share) => share.uid === membership.uid);
        return send(response, 200, {
          session: { ...session, keyShares: undefined, keyShare: mine },
          members: await store.members(membership.orgId),
          you: membership,
          comments: await store.comments(membership.orgId, oneSession[1]),
          audit: await store.auditFor(membership.orgId, oneSession[1]),
        });
      }

      /* ---- Comments ---- */

      const commentRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})\/comments$/);
      if (request.method === "POST" && commentRoute) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await addComment(store, membership, commentRoute[1], String(body.body ?? ""));
        if (!result.ok) return send(response, result.status, { error: result.error });
        return send(response, 201, { comment: result.value });
      }

      /* ---- Inbox ---- */

      if (route === "GET /api/notifications") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const view = await inbox(store, membership);
        return send(response, 200, { ...view, members: await store.members(membership.orgId) });
      }

      if (route === "POST /api/notifications/read") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body.id === "string") {
          await store.markNotificationRead(membership.uid, body.id);
        } else {
          await store.markAllNotificationsRead(membership.uid);
        }
        return send(response, 200, await inbox(store, membership));
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
