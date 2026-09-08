import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Store } from "./lib/store";
import type { Invite, Membership } from "./lib/orgs";
import type { VerifyResult } from "./lib/firebase-token";
import { exchangeCode, issueCode } from "./lib/codes";
import {
  checkAccessToken,
  issueTokens,
  refreshAccessToken,
  revokeByRefreshToken,
} from "./lib/tokens";
import { isValidRedirectUri } from "./lib/redirect";
import {
  closeSession,
  listSessions,
  registerSession,
  sessionForApi,
  sessionSource,
} from "./lib/sessions";
import { mintSecret } from "./lib/tokens";
import {
  changeRole,
  createInvite,
  describeOrganization,
  ensureMembership,
  previewInvite,
  removeMember,
  renameOrganization,
  notifyInvited,
  revokeInvite,
} from "./routes/organizations";
import { assignSession, auditCsv } from "./routes/audit";
import { addComment, inbox, notifyAssigned, notifySessionStarted } from "./routes/social";
import { callerAddress, rateLimiter } from "./lib/rate-limit";
import { logMailer, type Mailer } from "./lib/mail";

export interface AppOptions {
  store: Store;
  verifyIdToken: (token: string) => Promise<VerifyResult>;
  allowedOrigins: string[];
  /**
   * Where browsers reach this deployment. Links sent by email are built from
   * it, so it has to be the public URL rather than whatever the request
   * happened to arrive on.
   */
  webOrigin?: string;
  /**
   * Whether an X-Forwarded-For header may be believed. Only true when the
   * deployment puts a proxy in front that rewrites it; see callerAddress.
   */
  trustProxy?: boolean;
  /** Where server-side faults go. Overridden in tests to keep them quiet. */
  log?: (message: string, error?: unknown) => void;
  /**
   * Sends invitations. Absent means they are logged instead, which is what
   * development wants and what keeps an unconfigured deployment from failing
   * an invite whose link is perfectly good.
   */
  mailer?: Mailer;
  /**
   * Serves the built client for anything that is not an API route. Present
   * only in a deployment that serves the app and the API together; in
   * development Vite serves the client on its own port.
   */
  serveClient?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /**
   * Forwards /relay/* to the relay. The websocket half is wired to the
   * server's upgrade event; this is the ordinary-request half.
   */
  relay?: {
    handles(url: string | undefined): boolean;
    request(request: IncomingMessage, response: ServerResponse): void;
  };
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * An error the caller caused, safe to describe back to them.
 *
 * Anything else is a fault on this side: the caller gets a status and nothing
 * more, because a database driver's message describes our schema, not their
 * mistake.
 */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/*
 * Minting or exchanging credentials is the expensive thing to guess at, so it
 * gets a budget a person cannot notice and a script runs out of in a second.
 * Everything else shares a larger one: an agent polls every two seconds and a
 * browser has several panes open, and neither may ever be refused.
 */
const CREDENTIAL_ROUTES = new Set([
  "POST /api/cli/authorize",
  "POST /api/cli/token",
  "POST /api/cli/refresh",
  "POST /api/cli/revoke",
]);
const CREDENTIAL_BUCKET = { burst: 12, perSecond: 0.2 };
const GENERAL_BUCKET = { burst: 240, perSecond: 40 };

/*
 * This service answers JSON to a known origin and serves no markup of its own,
 * so the sandboxing headers can be absolute. They cost nothing and mean a
 * response reflected somewhere unexpected cannot be made to do anything.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-site",
};

/* An agent polls every 2s, so this is generous enough to survive a hiccup. */
export const AGENT_ONLINE_MS = 15_000;

/*
 * The agent harnesses a machine may report having. The same ids appear in the
 * CLI's detection table and in the browser's session catalogue; keeping the
 * accepted set here means a machine cannot make this service store a string
 * nobody asked for, and that a harness added to one side is dropped until it
 * is added to all three.
 */
const KNOWN_HARNESSES = new Set(["claude-code", "codex", "hermes", "openclaw"]);

/**
 * Only the person whose machine owns a session may mutate its encryption
 * shares or stop its process. Assignment grants terminal input, not control
 * over the owner's machine, and an organization role must never silently
 * broaden into remote-process administration.
 */
function ownsSession(membership: Membership, session: { ownerUid?: string; uid: string }): boolean {
  return (session.ownerUid ?? session.uid) === membership.uid;
}

/**
 * The harnesses a polling agent claims, keeping only the recognised ones.
 *
 * Returns undefined when the agent said nothing at all, which the store reads
 * as "leave the last report alone". An agent that reports only unknown ids has
 * still reported, so the answer is an empty list rather than silence: the
 * browser can then say a tool is absent, which is what the machine claimed.
 */
function readHarnesses(url: URL): string[] | undefined {
  const raw = url.searchParams.getAll("harnesses");
  if (raw.length === 0) return undefined;
  const named = raw.flatMap((value) => value.split(",")).map((id) => id.trim());
  return [...new Set(named.filter((id) => KNOWN_HARNESSES.has(id)))].sort();
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(413, "body too large"));
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
        reject(new RequestError(400, "body is not valid JSON"));
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
  const trustProxy = options.trustProxy ?? false;
  const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error));
  const mailer = options.mailer ?? logMailer();
  /* The first allowed origin is the web app's; see readConfig. */
  const webOrigin = options.webOrigin ?? allowedOrigins[0] ?? "";
  const credentialLimit = rateLimiter(CREDENTIAL_BUCKET);
  const generalLimit = rateLimiter(GENERAL_BUCKET);

  function send(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
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

    /*
     * Liveness is answered before anything else can refuse it. It says the
     * process is running and nothing more, so an orchestrator does not restart
     * a healthy container because the database it depends on is busy.
     */
    if (route === "GET /api/health") return send(response, 200, { ok: true });

    /*
     * Forwarded before the limiter: this is the terminal's own traffic, and
     * counting a busy session against a budget meant for credential guessing
     * would cut off the thing the app exists to do.
     */
    if (options.relay?.handles(request.url)) {
      return options.relay.request(request, response);
    }

    const caller = callerAddress(request.headers, request.socket?.remoteAddress, trustProxy);
    const limiter = CREDENTIAL_ROUTES.has(route) ? credentialLimit : generalLimit;
    const decision = limiter.take(caller);
    if (!decision.ok) {
      response.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
      return send(response, 429, { error: "too many requests" });
    }

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
        /*
         * A machine id only ever selects a device inside the account that just
         * proved itself, so its shape is the whole check. One that does not
         * fit is treated as absent rather than refused: a CLI with a damaged
         * identifier should still be able to sign in, and pays for it with a
         * duplicate entry rather than a failure it cannot act on.
         */
        const claimed = body.machine_id;
        const machineId =
          typeof claimed === "string" && claimed.length <= 128 && /^[A-Za-z0-9_-]+$/.test(claimed)
            ? claimed
            : undefined;
        const tokens = await issueTokens(store, {
          uid: result.uid,
          email: result.email,
          name: result.name,
          label: String(body.label ?? "shell cli").slice(0, 80),
          machineId,
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
        /*
         * Awaited so a mail provider's refusal is in the log by the time the
         * request is answered, but never fatal: the invite exists either way
         * and the link can still be copied out of the page.
         */
        if (result.status === 201) {
          const invite = (result.body as { invite?: Invite }).invite;
          if (invite) await notifyInvited(store, mailer, webOrigin, membership, invite, log);
        }
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
          deviceId: token.id,
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
        return send(response, 201, { session: sessionForApi(result.session) });
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
          return { ...sessionForApi(session), keyShares: undefined, keyShare: mine };
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
        const session = await store.sessionInOrg(membership.orgId, shareRoute[1]);
        if (!session) return send(response, 404, { error: "no such session" });
        if (!ownsSession(membership, session)) {
          return send(response, 403, { error: "only the session owner can share its key" });
        }

        const body = (await readBody(request)) as Record<string, unknown>;
        const incoming = Array.isArray(body.shares) ? body.shares : [];
        const shares = incoming
          .map((entry) => entry as Record<string, unknown>)
          .filter(
            (entry) =>
              typeof entry.uid === "string" &&
              typeof entry.sender_public_key === "string" &&
              typeof entry.sealed === "string",
          )
          .slice(0, 100)
          .map((entry) => ({
            uid: String(entry.uid),
            senderPublicKey: String(entry.sender_public_key ?? ""),
            sealed: String(entry.sealed),
          }));

        if (shares.length !== incoming.length || shares.some(
          (share) => !share.uid || !share.senderPublicKey || !share.sealed ||
            share.senderPublicKey.length > 512 || share.sealed.length > 4096,
        )) {
          return send(response, 400, { error: "invalid key share" });
        }

        const memberIds = new Set((await store.members(membership.orgId)).map((member) => member.uid));
        if (shares.some((share) => !memberIds.has(share.uid))) {
          return send(response, 400, { error: "key shares may only be sent to organization members" });
        }

        await store.putKeyShares(membership.orgId, shareRoute[1], shares);
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
         * Only a machine that is polling can carry work out. Queuing for one
         * that is not would sit there silently forever, which is a worse
         * answer than saying so now.
         */
        if (!device.agentSeenAt || Date.now() - device.agentSeenAt > AGENT_ONLINE_MS) {
          return send(response, 409, {
            error:
              `${device.label} is not reachable. Sign in there with 'shell login' ` +
              `and allow browser-started sessions, then try again.`,
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
          const scope = await store.membershipOf(identity.uid);
          const session = scope
            ? await store.sessionInOrg(scope.orgId, sessionId)
            : (await listSessions(store, identity.uid)).find((entry) => entry.id === sessionId) ?? null;
          if (!session) return send(response, 404, { error: "no such session" });
          if ((session.ownerUid ?? session.uid) !== identity.uid) {
            return send(response, 403, { error: "only the session owner can stop its process" });
          }
          const ownerDeviceId = sessionSource(session).deviceId;
          if (!ownerDeviceId) {
            return send(response, 409, {
              error: "this older session has no machine identity; stop it from that machine",
            });
          }
          if (ownerDeviceId !== deviceId) {
            return send(response, 409, { error: "that session is running on a different machine" });
          }
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
        await store.markAgentSeen(
          token.id,
          url.searchParams.get("key") ?? undefined,
          readHarnesses(url),
        );
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
          session: { ...sessionForApi(session), keyShares: undefined, keyShare: mine },
          members: await store.members(membership.orgId),
          you: membership,
          comments: await store.comments(membership.orgId, oneSession[1]),
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

      /*
       * Readiness, unlike health, reports whether this instance can actually
       * serve: a cheap read that fails when the database is unreachable, so a
       * rolling deploy waits rather than sending traffic into errors.
       */
      if (route === "GET /api/ready") {
        try {
          await store.membershipOf("readiness-probe");
          return send(response, 200, { ok: true });
        } catch (error) {
          log("accounts: readiness probe failed", error);
          return send(response, 503, { error: "not ready" });
        }
      }

      /*
       * Not an API route. When this process also serves the app, the path
       * belongs to the client router; otherwise there is nothing here.
       */
      if (options.serveClient && !url.pathname.startsWith("/api/")) {
        return options.serveClient(request, response);
      }
      return send(response, 404, { error: "no such route" });
    } catch (error) {
      if (error instanceof RequestError) {
        return send(response, error.status, { error: error.message });
      }
      /*
       * Nothing here described a caller's mistake, so it is one of ours. The
       * detail goes to the log, where it can be read; the caller gets a status
       * and a fixed sentence, because a driver error message describes this
       * service's internals rather than their request.
       */
      log(`accounts: ${route} failed`, error);
      return send(response, 500, { error: "internal error" });
    }
  };
}

export function createAccountsServer(options: AppOptions) {
  return createServer(createApp(options));
}
