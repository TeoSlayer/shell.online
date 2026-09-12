import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Store } from "./lib/store";
import type { Invite, Membership } from "./lib/orgs";
import type { AuditEvent, SessionRecord } from "./lib/types";
import type { VerifyResult } from "./lib/firebase-token";
import type { SessionLiveness, SessionLivenessSource } from "./lib/session-liveness";
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
  RESET_SIGN_IN_WINDOW_MS,
  isP256PublicKey,
  readOwnerShare,
  readSessionKeyShare,
  readVaultInput,
  vaultForApi,
  readVaultWrapUpdate,
} from "./lib/vault";
import { isAuditEnvelope, isTeamKeyShare } from "./lib/audit-seal";
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
import { recordAudit, assignSession, auditCsv, SEALED_KINDS } from "./routes/audit";
import { addComment, inbox, notifyAssigned, notifySessionStarted } from "./routes/social";
import { deleteAccount } from "./routes/account";
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
  /** Relay-backed process state. Absent only in API-only development setups. */
  sessionLiveness?: SessionLivenessSource;
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
  "DELETE /api/account",
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

/*
 * Who besides the owner holds a sealed copy of a session's password. Told to
 * the owner only: it is theirs to know, and the service knows it anyway
 * because it stores the copies.
 */
function sharedWith(
  membership: Membership,
  session: { ownerUid?: string; uid: string; keyShares?: { uid: string }[] },
): string[] | undefined {
  if (!ownsSession(membership, session)) return undefined;
  return (session.keyShares ?? []).map((share) => share.uid).filter((uid) => uid !== membership.uid);
}

/**
 * The session shape one signed-in member may receive.
 *
 * A stored session carries one sealed password per recipient. Even though a
 * member cannot decrypt somebody else's copy, sending the whole array leaks
 * who has a credential and makes an optimistic assignment response lose the
 * caller's singular `keyShare` shape until the next poll. Every app response
 * therefore goes through the same projection as the list and detail routes.
 */
function sessionForMember(
  membership: Membership,
  session: SessionRecord,
  liveness?: SessionLiveness,
) {
  const mine = session.keyShares?.find((share) => share.uid === membership.uid);
  return {
    ...sessionForApi(session),
    keyShare: mine,
    sharedWith: sharedWith(membership, session),
    ...liveness,
  };
}

/*
 * Copies of the team audit key as a browser sends them. Null for anything that
 * is not a list of well-formed copies, one per person: they are refused
 * together rather than stored in part.
 */
function readTeamShares(value: unknown): { uid: string; sealed: string }[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
  const shares = value.map((entry) => (entry ?? {}) as Record<string, unknown>);
  if (shares.some((share) => typeof share.uid !== "string" || !share.uid || !isTeamKeyShare(share.sealed))) {
    return null;
  }
  if (new Set(shares.map((share) => share.uid)).size !== shares.length) return null;
  return shares.map((share) => ({ uid: share.uid as string, sealed: share.sealed as string }));
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

/*
 * Records that a session was stopped or removed, and does not let a failure
 * to record it stop the thing being recorded.
 *
 * The set of kinds lives in the database as a check constraint as well as in
 * this code, and the two can be out of step: a deployment that runs before its
 * migration rejects the write. An operator stopping a runaway process should
 * not be told "internal error" because the trail could not be written, which
 * is exactly what happened when these two kinds were added ahead of the
 * migration that allows them.
 *
 * Loud in the log, because a missing audit entry is a real gap and nobody
 * should have to notice it by its absence.
 */
async function noteSessionEvent(
  store: Store,
  membership: Membership,
  sessionId: string,
  kind: "stopped" | "deleted",
  session: { name?: string; command: string },
): Promise<void> {
  try {
    await recordAudit(store, membership, {
      sessionId,
      kind,
      text: session.name?.trim() || session.command,
    });
  } catch (error) {
    /*
     * Specifiers rather than interpolation. console.error treats its first
     * argument as a format string, so a value carrying a "%s" would consume
     * the error argument and print itself instead. Neither value can do that
     * today -- kind is one of two literals, and a session id has matched
     * /^[A-Za-z0-9_-]{6,64}$/ to exist at all -- but that is an argument from
     * validation two files away, and this form does not need it.
     */
    console.error(
      "accounts: could not record %s for session %s",
      kind,
      sessionId,
      error instanceof Error ? error.message : error,
    );
  }
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

  async function sessionsForMember(membership: Membership, sessions: SessionRecord[]) {
    const states = options.sessionLiveness
      ? await options.sessionLiveness.many(sessions)
      : new Map<string, SessionLiveness>();
    return sessions.map((session) =>
      sessionForMember(membership, session, states.get(session.id))
    );
  }

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
    return (await ensureMembership(store, identity, inviteId))?.membership ?? null;
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
        if (!resolved) return send(response, 401, { error: "sign in first" });
        /* Publishing the browser key here keeps it current without a
           separate call on every sign-in. */
        const publicKey = url.searchParams.get("key");
        if (publicKey && !(await isP256PublicKey(publicKey))) {
          return send(response, 400, { error: "invalid browser public key" });
        }
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

      /*
       * Typed input, sealed in the browser to the team's audit key. An entry
       * that is not sealed is refused rather than stored: a browser still
       * running an older build loses the entry, which is a gap in the trail
       * and not a plaintext copy of what somebody typed.
       */
      if (route === "POST /api/audit") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const entries = Array.isArray(body.entries) ? body.entries : [];
        let written = 0;
        let refused = 0;
        for (const entry of entries.slice(0, 100)) {
          const candidate = entry as Record<string, unknown>;
          /*
           * Handoffs, stops and deletions are service facts written beside the
           * action itself. Letting a browser submit those kinds would let any
           * member forge the team's audit trail with a plain API request.
           */
          if (!SEALED_KINDS.has(String(candidate.kind ?? "input"))) {
            refused += 1;
            continue;
          }
          const result = await recordAudit(store, membership, {
            sessionId: String(candidate.session_id ?? ""),
            kind: String(candidate.kind ?? "input"),
            text: String(candidate.text ?? ""),
            at: typeof candidate.at === "number" ? candidate.at : undefined,
          });
          if (result.ok) written += 1;
          else refused += 1;
        }
        return send(response, 200, { written, refused });
      }

      /*
       * The team's audit key: its public half, and the caller's own sealed
       * copy of the private half. Nobody is handed anyone else's copy.
       * `missing` names the members with a vault and no copy yet, so any
       * teammate who holds the key can seal one for them.
       */
      if (route === "GET /api/team-key") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const key = await store.teamKey(membership.orgId);
        const shares = key ? await store.teamKeyShares(membership.orgId) : [];
        const mine = shares.find((share) => share.uid === membership.uid && share.version === key?.version);
        const holders = new Set(
          shares.filter((share) => share.version === key?.version).map((share) => share.uid),
        );
        const missing = key
          ? (await store.members(membership.orgId))
            .filter((member) => member.accountKey && !holders.has(member.uid))
            .map((member) => ({ uid: member.uid, accountKey: member.accountKey }))
          : [];
        return send(response, 200, {
          teamKey: key
            ? { publicKey: key.publicKey, version: key.version, createdBy: key.createdBy, createdAt: key.createdAt }
            : null,
          share: mine ? { senderUid: mine.senderUid, sealed: mine.sealed, version: mine.version } : null,
          missing,
          you: { uid: membership.uid, role: membership.role, orgId: membership.orgId },
        });
      }

      /*
       * The first member to need the key makes it, in their browser, and seals
       * the private half to every member with a vault. The service keeps the
       * public half and the sealed copies. Create-only, so two browsers making
       * one at once cannot both believe theirs is the team's.
       */
      if (route === "POST /api/team-key") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        if (!(await isP256PublicKey(body.public_key))) {
          return send(response, 400, { error: "invalid public key" });
        }
        const shares = readTeamShares(body.shares);
        if (!shares) return send(response, 400, { error: "invalid key shares" });
        const memberIds = new Set((await store.members(membership.orgId)).map((member) => member.uid));
        if (shares.some((share) => !memberIds.has(share.uid))) {
          return send(response, 400, { error: "key shares may only be sent to organization members" });
        }
        if (!shares.some((share) => share.uid === membership.uid)) {
          return send(response, 400, { error: "include your own copy of the key" });
        }
        const now = Date.now();
        const key = {
          orgId: membership.orgId,
          publicKey: body.public_key as string,
          version: 1,
          createdBy: membership.uid,
          createdAt: now,
        };
        if (!(await store.putTeamKey(key))) {
          return send(response, 409, { error: "this team already has an audit key" });
        }
        await store.putTeamKeyShares(shares.map((share) => ({
          orgId: membership.orgId,
          uid: share.uid,
          version: key.version,
          senderUid: membership.uid,
          sealed: share.sealed,
          createdAt: now,
        })));
        return send(response, 201, {
          teamKey: { publicKey: key.publicKey, version: key.version, createdBy: key.createdBy, createdAt: key.createdAt },
        });
      }

      /*
       * A teammate who holds the key sealing it for members who have none.
       * Insert-only, so nobody can replace a working copy with one that does
       * not open; the version must be the current one so a copy of a key that
       * has been replaced is not handed out.
       */
      if (route === "PUT /api/team-key/shares") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const key = await store.teamKey(membership.orgId);
        if (!key) return send(response, 404, { error: "this team has no audit key yet" });
        if (body.version !== key.version) {
          return send(response, 409, { error: "the team's audit key has changed; reload and try again" });
        }
        const shares = readTeamShares(body.shares);
        if (!shares) return send(response, 400, { error: "invalid key shares" });
        const current = await store.teamKeyShares(membership.orgId);
        if (!current.some((share) =>
          share.uid === membership.uid && share.version === key.version
        )) {
          return send(response, 403, {
            error: "open your own copy of the team key before sharing it",
          });
        }
        const memberIds = new Set((await store.members(membership.orgId)).map((member) => member.uid));
        if (shares.some((share) => !memberIds.has(share.uid))) {
          return send(response, 400, { error: "key shares may only be sent to organization members" });
        }
        const now = Date.now();
        const shared = await store.putTeamKeyShares(shares.map((share) => ({
          orgId: membership.orgId,
          uid: share.uid,
          version: key.version,
          senderUid: membership.uid,
          sealed: share.sealed,
          createdAt: now,
        })));
        return send(response, 200, { shared });
      }

      /*
       * Only ever the caller's own copy: for when it no longer opens, such as
       * after a vault reset, so that a teammate can seal a fresh one.
       */
      if (route === "DELETE /api/team-key/share") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        return send(response, 200, { deleted: await store.deleteTeamKeyShare(membership.orgId, membership.uid) });
      }

      /*
       * Typed input recorded before the audit key existed, still in
       * plaintext. An owner or admin's browser reads it, seals each entry to
       * the team key and writes it back, after which the service holds no
       * readable copy. Limited to them because a sealed entry replaces the
       * original, and a trail anyone could overwrite would not be a trail.
       */
      if (route === "GET /api/audit/plaintext") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        if (membership.role !== "owner" && membership.role !== "admin") {
          return send(response, 403, { error: "only an owner or admin can seal the team's history" });
        }
        const asked = Number(url.searchParams.get("limit") ?? "");
        const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 200) : 100;
        return send(response, 200, { events: await store.plaintextAudit(membership.orgId, limit) });
      }

      if (route === "POST /api/audit/seal") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        if (membership.role !== "owner" && membership.role !== "admin") {
          return send(response, 403, { error: "only an owner or admin can seal the team's history" });
        }
        const body = (await readBody(request)) as Record<string, unknown>;
        const entries = Array.isArray(body.entries) ? body.entries.slice(0, 200) : [];
        let sealed = 0;
        for (const entry of entries) {
          const candidate = entry as Record<string, unknown>;
          if (typeof candidate.id !== "string" || !(await isAuditEnvelope(candidate.text))) continue;
          /*
           * Recorded against the person whose browser sealed it. They were
           * handed the session, the author and the time by this service, so a
           * re-sealed entry must not read as the words of the person it names.
           */
          const done = await store.sealAudit(
            membership.orgId,
            candidate.id,
            candidate.text as string,
            membership.uid,
          );
          if (done) sealed += 1;
        }
        return send(response, 200, { sealed });
      }

      /*
       * The whole team's trail, which is what the page needs.
       *
       * Reading it session by session cannot show what happened to a session
       * that no longer exists, and the entry recording its removal is exactly
       * the one somebody comes here to find.
       */
      if (route === "GET /api/audit") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const askedLimit = Number(url.searchParams.get("limit") ?? "");
        const askedPage = Number(url.searchParams.get("page") ?? "");
        const limit = Number.isInteger(askedLimit) && askedLimit > 0
          ? Math.min(askedLimit, 100)
          : 50;
        const page = Number.isInteger(askedPage) && askedPage > 0
          ? Math.min(askedPage, 10_000)
          : 1;
        const askedKind = url.searchParams.get("kind") ?? "";
        const kinds = new Set(["input", "interrupt", "opened", "handoff", "stopped", "deleted"]);
        const askedSince = Number(url.searchParams.get("since_at") ?? "");
        const result = await store.auditPage(membership.orgId, {
          limit,
          offset: (page - 1) * limit,
          sessionId: url.searchParams.get("session")?.slice(0, 64) || undefined,
          actorUid: url.searchParams.get("actor")?.slice(0, 256) || undefined,
          kind: kinds.has(askedKind) ? askedKind as AuditEvent["kind"] : undefined,
          /*
           * No text search. Typed input is ciphertext here, and the service
           * cannot search what it cannot read; the browser searches what it
           * has decrypted.
           */
          sinceAt: Number.isFinite(askedSince) && askedSince > 0 ? askedSince : undefined,
        });
        return send(response, 200, { ...result, page, limit });
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

      /*
       * Kept for scripts written against the prerelease API. Typed input in it
       * is ciphertext now, sealed to the team's audit key: the app builds its
       * export in the browser, from what it has decrypted.
       */
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

      /* ---- Session vault ---- */

      /*
       * A vault is a public key and two pieces of ciphertext. Its owner gets it
       * back whole, since none of it opens without the recovery key, and
       * nobody else gets any of it but the public key.
       */
      if (route === "GET /api/vault") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        const key = await store.accountKey(identity.uid);
        return send(response, 200, { vault: key ? vaultForApi(key) : null });
      }

      if (route === "POST /api/vault") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        const input = await readVaultInput((await readBody(request)) as Record<string, unknown>);
        if (!input.ok) return send(response, 400, { error: input.reason });
        const { publicKey, encryptedPrivateKey, recoveryWrap, replaceVersion } = input.value;
        const now = Date.now();

        if (replaceVersion === undefined) {
          const created = await store.putAccountKey({
            uid: identity.uid,
            publicKey,
            encryptedPrivateKey,
            recoveryWrap,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
          if (!created) return send(response, 409, { error: "this account already has a vault" });
          const stored = await store.accountKey(identity.uid);
          return send(response, 201, { vault: stored ? vaultForApi(stored) : null });
        }

        /*
         * A reset puts a new key where colleagues and machines seal passwords,
         * so a token that has only been refreshed is not enough for it. The
         * person has to have signed in recently.
         */
        if (!identity.authTime || now - identity.authTime > RESET_SIGN_IN_WINDOW_MS) {
          return send(response, 403, {
            error: "Resetting your vault needs a recent sign-in. Sign out, sign back in, and reset within ten minutes.",
            reauthenticate: true,
          });
        }
        const existing = await store.accountKey(identity.uid);
        const stale = { error: "Your vault changed since this page loaded. Reload and try again." };
        if (!existing || existing.version !== replaceVersion) return send(response, 409, stale);
        const replaced = await store.putAccountKey(
          {
            uid: identity.uid,
            publicKey,
            encryptedPrivateKey,
            recoveryWrap,
            version: existing.version + 1,
            createdAt: existing.createdAt,
            updatedAt: now,
          },
          existing.version,
        );
        if (!replaced) return send(response, 409, stale);
        const stored = await store.accountKey(identity.uid);
        return send(response, 200, { vault: stored ? vaultForApi(stored) : null });
      }

      if (route === "PATCH /api/vault") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        const input = readVaultWrapUpdate((await readBody(request)) as Record<string, unknown>);
        if (!input.ok) return send(response, 400, { error: input.reason });
        const now = Date.now();
        if (!identity.authTime || now - identity.authTime > RESET_SIGN_IN_WINDOW_MS) {
          return send(response, 403, {
            error: "Changing vault unlock methods needs a recent sign-in. Sign out and sign back in first.",
            reauthenticate: true,
          });
        }
        const updated = await store.updateAccountKeyWrap(identity.uid, input.version, input.recoveryWrap, now);
        if (!updated) return send(response, 409, { error: "Your vault changed. Reload and try again." });
        const stored = await store.accountKey(identity.uid);
        return send(response, 200, { vault: stored ? vaultForApi(stored) : null });
      }

      /*
       * What a machine seals its sessions' passwords to. The CLI pins the key
       * it was given when it signed in, and uses this only to notice a change
       * or to learn a key it was never given.
       */
      if (route === "GET /api/account/key") {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const key = await store.accountKey(token.uid);
        if (!key) return send(response, 404, { error: "no vault" });
        return send(response, 200, { public_key: key.publicKey, version: key.version });
      }

      /*
       * Deleting an account. An ID token reaches it, not a membership, so a
       * second request -- the browser retrying after Firebase refused to
       * delete the sign-in -- finds nothing left to remove and still succeeds.
       */
      if (route === "DELETE /api/account") {
        const identity = await requireUser(request);
        if (!identity) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const result = await deleteAccount(store, identity, body.confirm);
        return send(response, result.status, result.body);
      }

      /* ---- Session registry ---- */
      if (route === "POST /api/sessions") {
        const token = await requireCli(request);
        if (!token) return send(response, 401, { error: "not signed in" });
        const body = (await readBody(request)) as Record<string, unknown>;
        const membership = await store.membershipOf(token.uid);
        const rotation = body.credential_rotation === true;
        const previous = rotation && membership
          ? await store.sessionInOrg(membership.orgId, String(body.id ?? ""))
          : null;
        if (rotation && (!previous || (previous.ownerUid ?? previous.uid) !== token.uid)) {
          return send(response, 404, { error: "no such owned session to rotate" });
        }
        if (rotation) {
          const nextURL = String(body.share_url ?? "");
          if (
            !previous?.encrypted || body.encrypted !== true ||
            nextURL === previous.shareUrl || !/#salt=[A-Za-z0-9_-]{22}$/.test(nextURL)
          ) {
            return send(response, 400, { error: "invalid credential rotation" });
          }
          const ownerShare = await readOwnerShare(body.owner_share);
          const shares = ownerShare ? [{ uid: token.uid, ...ownerShare }] : [];
          const rotated = await store.rotateSessionCredentials(
            membership!.orgId,
            previous!.id,
            token.uid,
            nextURL,
            shares,
          );
          if (!rotated) return send(response, 404, { error: "no such owned session to rotate" });
          return send(response, 201, { session: sessionForApi(rotated) });
        }
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
        /*
         * The CLI's own copy of the password, sealed to this account's vault,
         * so the web app can open the session without asking anyone to type
         * it. Optional and opaque: one that is not shaped like a share is
         * dropped, and never allowed to fail the registration.
         */
        const ownerShare = result.session.encrypted && result.session.orgId
          ? await readOwnerShare(body.owner_share)
          : null;
        if (ownerShare && result.session.orgId) {
          await store.putKeyShares(result.session.orgId, result.session.id, [
            { uid: token.uid, ...ownerShare },
          ]);
        }
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

      /*
       * Removes a session from the lists without touching the machine that
       * ran it. The process has already exited, or is being abandoned on
       * purpose; either way what it left on disk is not ours to delete. This
       * is the record going away, and the audit entry is what remains of it.
       */
      const deleteMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{6,64})$/);
      if (request.method === "DELETE" && deleteMatch) {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const sessionId = deleteMatch[1];
        const session = await store.sessionInOrg(membership.orgId, sessionId);
        if (!session) return send(response, 404, { error: "no such session" });

        /* The person whose machine ran it, or somebody who runs the team. */
        const isOwner = (session.ownerUid ?? session.uid) === membership.uid;
        const isAdmin = membership.role === "owner" || membership.role === "admin";
        if (!isOwner && !isAdmin) {
          return send(response, 403, { error: "only the session's owner can remove it" });
        }

        /* Written first: after the row is gone there is nothing to attach to. */
        await noteSessionEvent(store, membership, sessionId, "deleted", session);
        if (!(await store.deleteSession(membership.orgId, sessionId))) {
          return send(response, 404, { error: "no such session" });
        }
        return send(response, 200, { deleted: true });
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
        const sessions = await sessionsForMember(
          membership,
          await store.listOrgSessions(membership.orgId),
        );
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
        /*
         * The owner shares with colleagues. Anyone else may keep only their
         * own copy: a password they typed and saw work, sealed to their own
         * vault so they need not type it again. That grants them nothing they
         * did not already hold.
         */
        const isOwner = ownsSession(membership, session);

        const body = (await readBody(request)) as Record<string, unknown>;
        const incoming = Array.isArray(body.shares) ? body.shares : [];
        if (incoming.length > 100) {
          return send(response, 400, { error: "invalid key share" });
        }
        const shares: { uid: string; senderPublicKey: string; sealed: string }[] = [];
        for (const candidate of incoming) {
          if (!candidate || typeof candidate !== "object") {
            return send(response, 400, { error: "invalid key share" });
          }
          const entry = candidate as Record<string, unknown>;
          if (typeof entry.uid !== "string" || !entry.uid) {
            return send(response, 400, { error: "invalid key share" });
          }
          const parsed = await readSessionKeyShare(entry);
          if (!parsed) return send(response, 400, { error: "invalid key share" });
          shares.push({ uid: entry.uid, ...parsed });
        }
        if (!isOwner && shares.some((share) => share.uid !== membership.uid)) {
          return send(response, 403, { error: "only the session owner can share its key" });
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
        const requested = Array.isArray(body.uids)
          ? body.uids.map(String)
          : body.uid
            ? [String(body.uid)]
            : [];
        const result = await assignSession(store, membership, assignRoute[1], requested);
        if (!result.ok) return send(response, result.status, { error: result.error });
        for (const uid of result.addedUids) {
          await notifyAssigned(
            store,
            membership,
            assignRoute[1],
            uid,
            result.session.name || result.session.command,
          );
        }
        return send(response, 200, { session: sessionForMember(membership, result.session) });
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

        if (kind === "start") {
          /*
           * Starting names a machine, so the caller's choice is the subject
           * and checking it here is right. Stopping does not: it names a
           * session, and which machine that reaches is the session's business,
           * resolved in that branch. Checking the caller's copy for both is
           * what made stopping fail with "no such machine".
           */
          const device = (await store.listDevices(identity.uid)).find(
            (entry) => entry.id === deviceId,
          );
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
          /*
           * Recorded before the machine is asked, not after. The queue is the
           * decision; whether the process was still alive to receive it is a
           * fact about the machine, and an organization asking who stopped
           * this wants the person who pressed it either way.
           */
          if (scope) await noteSessionEvent(store, scope, sessionId, "stopped", session);

          /*
           * The target comes from the session, not from the caller.
           *
           * The browser echoes back the device id the session was started on,
           * and that id goes stale in a way nobody would connect to the button
           * they pressed: unlinking a machine revokes its device row, signing
           * in again deliberately makes a new one, and every session started
           * before that still names the old row. Validating the caller's copy
           * answered "no such machine" about a machine that was sitting there
           * polling under a new id.
           *
           * So the recorded device is preferred while it is live, and
           * otherwise the machine it belonged to is followed to whichever
           * device is carrying it now.
           */
          const recorded = sessionSource(session).deviceId;
          if (!recorded) {
            return send(response, 409, {
              error: "this older session has no machine identity; stop it from that machine",
            });
          }

          const live = await store.listDevices(identity.uid);
          let target = live.find((entry) => entry.id === recorded);
          if (!target) {
            const machine = await store.machineForDevice(identity.uid, recorded);
            const current = machine ? await store.deviceForMachine(identity.uid, machine) : null;
            target = current ? live.find((entry) => entry.id === current.id) : undefined;
          }
          if (!target) {
            return send(response, 409, {
              error:
                "the machine that started this session is no longer linked. " +
                "Stop it there with 'shell kill', or sign that machine in again.",
            });
          }
          if (!target.agentSeenAt || Date.now() - target.agentSeenAt > AGENT_ONLINE_MS) {
            return send(response, 409, {
              error:
                `${target.label} is not reachable, so the stop cannot be delivered. ` +
                `Sign in there with 'shell login' and allow browser-started sessions.`,
            });
          }

          const queued = {
            id: mintSecret("cmd"),
            uid: identity.uid,
            deviceId: target.id,
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
        const agentPublicKey = url.searchParams.get("key") ?? undefined;
        if (agentPublicKey && !(await isP256PublicKey(agentPublicKey))) {
          return send(response, 400, { error: "invalid agent public key" });
        }
        await store.markAgentSeen(
          token.id,
          agentPublicKey,
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

        /*
         * A stop that the machine carried out closes the session here too.
         *
         * A session normally reports its own exit, using the credentials it
         * started with. Those are revoked when the machine is unlinked, so a
         * session started before that can never report anything again: the
         * process died on the machine and the row stayed open here, which
         * reads as a stop button that did nothing.
         *
         * The machine confirming it carried out the kill is the same fact,
         * arriving on credentials that are still valid.
         */
        if (!error) {
          const command = (await store.listCommands(token.uid)).find(
            (entry) => entry.id === doneMatch[1],
          );
          if (command?.kind === "kill" && command.sessionId) {
            await closeSession(store, token.uid, command.sessionId, undefined);
          }
        }
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
        const liveness = !session.closedAt && options.sessionLiveness
          ? await options.sessionLiveness.one(session.id)
          : undefined;
        return send(response, 200, {
          session: sessionForMember(membership, session, liveness),
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
        return send(response, 200, await inbox(store, membership));
      }

      if (route === "POST /api/notifications/read") {
        const membership = await requireMember(request);
        if (!membership) return send(response, 401, { error: "sign in first" });
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body.id === "string") {
          await store.markNotificationRead(membership.orgId, membership.uid, body.id);
        } else {
          await store.markAllNotificationsRead(membership.orgId, membership.uid);
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
