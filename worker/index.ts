import { DurableObject } from "cloudflare:workers";
import { decodeResize, Opcode } from "../shared/protocol";
import { chooseResizeOwner } from "../shared/resize-control";
import {
  binaryDownloadTarget,
  isDocumentNavigation,
  requestAnalyticsContext,
  writeAnalytics,
  type AnalyticsContext,
  type AnalyticsEvent,
  type DeviceClass,
} from "./analytics";
import { isStatsRange } from "../shared/stats";
import { RELEASE_VERSION } from "../shared/release";
import { viewerFrameAction } from "../shared/session-access";
import { persistentSessionID } from "../shared/persistent-session";
import {
  GITHUB_REPOSITORY_API_URL,
  GITHUB_REPOSITORY_URL,
  readGitHubApiStarCount,
} from "../shared/github";
import { STATS_PRESENCE_REFRESH_MS } from "../shared/stats-snapshot";
import {
  fetchStatsSnapshot,
  removeStatsPresence,
  StatsStore,
  submitStatsEvent,
  updateStatsPresence,
} from "./stats-store";
import {
  clearStatsSessionCookie,
  createStatsSession,
  createStatsSessionCookie,
  readStatsSessionCookie,
  verifyStatsPassword,
  verifyStatsSession,
} from "./stats-auth";

export { StatsStore };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DISCONNECTED_GRACE_MS = 15 * 60 * 1000;
const PERSISTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VIEWERS = 16;
const MAX_LIVE_FRAME_BYTES = 64 * 1024;
const MAX_INPUT_FRAME_BYTES = 16 * 1024 + 1;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_ENCRYPTION_OVERHEAD_BYTES = 29;
const TRAFFIC_WINDOW_MS = 10_000;
const HOST_WINDOW_BYTES = 40 * 1024 * 1024;
const VIEWER_WINDOW_BYTES = 1024 * 1024;
const MAX_FRAMES_PER_WINDOW = 2_000;
const TYPING_LEASE_MS = 1_800;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DOCUMENTATION_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FIRST_DYNAMIC_DOCUMENTATION_VERSION = "0.6.0";

type SessionStatus = "waiting" | "connected" | "disconnected" | "exited";
type SocketRole = "host" | "viewer";

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  SESSIONS: DurableObjectNamespace<TerminalSession>;
  STATS: DurableObjectNamespace<StatsStore>;
  SESSION_CREATION_LIMITER: RateLimitBinding;
  CONNECTION_LIMITER: RateLimitBinding;
  EVENT_LIMITER: RateLimitBinding;
  STATS_AUTH_LIMITER: RateLimitBinding;
  STATS_PASSWORD: string;
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
}

interface SessionMeta {
  hostTokenHash: string;
  readOnly: boolean;
  encrypted: boolean;
  label: string;
  createdAt: number;
  expiresAt: number;
  status: SessionStatus;
  exitCode?: number;
  startedAt?: number;
  runStartedAt?: number;
  shareOpenedAt?: number;
  collaborationStartedAt?: number;
  peakViewers?: number;
  presenceKey?: string;
  localAttached?: boolean;
  persistent: boolean;
}

interface SocketAttachment {
  role: SocketRole;
  id: number;
  guestNumber?: number;
  colorIndex?: number;
  typingAt?: number;
  localTypingAt?: number;
  device?: DeviceClass;
  client?: string;
  referrer?: string;
  ended?: boolean;
  resizeOwner?: boolean;
  cols?: number;
  rows?: number;
  snapshotRequestedAt?: number;
}

interface TrafficWindow {
  startedAt: number;
  bytes: number;
  frames: number;
}

interface CreateSessionBody {
  label?: unknown;
  read_only?: unknown;
  encrypted?: unknown;
  persistent?: unknown;
}

interface EventBody {
  event?: unknown;
  target?: unknown;
}

interface StatsLoginBody {
  password?: unknown;
}

interface InitializeSessionBody {
  hostTokenHash: string;
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  label: string;
  createdAt: number;
  expiresAt: number;
}

export default {
  async fetch(request, env, executionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "shell.online", version: RELEASE_VERSION });
    }

    if (url.pathname === "/api/github" && request.method === "GET") {
      return githubRepositorySummary();
    }

    if (url.pathname === "/api/docs/releases" && request.method === "GET") {
      return documentationReleases();
    }

    if (url.pathname === "/api/docs/content" && request.method === "GET") {
      return documentationContent(url);
    }

    if (url.pathname === "/api/stats" || url.pathname.startsWith("/api/stats/")) {
      return handleStatsRequest(request, env, url);
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      return createSession(request, env, url, executionContext);
    }

    if (url.pathname === "/api/sessions/resume" && request.method === "POST") {
      return resumeSession(request, env, url, executionContext);
    }

    const sessionStatusRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{32})$/);
    if (sessionStatusRoute && request.method === "GET") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await env.CONNECTION_LIMITER.limit({ key: ip });
      if (!allowed.success) {
        return json({ error: "too many session checks" }, 429, { "Retry-After": "60" });
      }
      return env.SESSIONS.getByName(sessionStatusRoute[1]).fetch(
        "https://session.internal/internal/status",
      );
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      return recordEvent(request, env, url, executionContext);
    }

    if (url.pathname === "/skill" || url.pathname === "/skill/") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      const skillUrl = new URL("/skill/shell-online/SKILL.md", url.origin);
      const skillAsset = await env.ASSETS.fetch(skillUrl);
      const response = secureAssetResponse(skillAsset, "/skill", url.hostname);
      recordAssetAnalytics(request, env, url, response, executionContext);
      return response;
    }

    const websocketRoute = url.pathname.match(
      /^\/api\/sessions\/([A-Za-z0-9_-]{32})\/ws$/,
    );
    if (websocketRoute) {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }

      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== requestOrigin(request, url)) {
        return json({ error: "origin not allowed" }, 403);
      }

      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await env.CONNECTION_LIMITER.limit({ key: ip });
      if (!allowed.success) {
        return json({ error: "too many connection attempts" }, 429, { "Retry-After": "60" });
      }

      const stub = env.SESSIONS.getByName(websocketRoute[1]);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const response = secureAssetResponse(assetResponse, url.pathname, url.hostname);
    recordAssetAnalytics(request, env, url, response, executionContext);
    return response;
  },
} satisfies ExportedHandler<Env>;

async function githubRepositorySummary(): Promise<Response> {
  try {
    const response = await fetch(GITHUB_REPOSITORY_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "shell.online",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 600,
      },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const stars = readGitHubApiStarCount(await response.json());
    if (stars === null) throw new Error("GitHub returned an invalid star count");

    return json(
      { stars, url: GITHUB_REPOSITORY_URL },
      200,
      {
        "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
      },
    );
  } catch {
    return json(
      { stars: null, url: GITHUB_REPOSITORY_URL },
      502,
      { "Cache-Control": "no-store" },
    );
  }
}

async function documentationReleases(): Promise<Response> {
  try {
    const response = await fetch(`${GITHUB_REPOSITORY_API_URL}/releases?per_page=50`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "shell.online",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cf: { cacheEverything: true, cacheTtl: 300 },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("GitHub returned invalid releases");
    const releases = payload.flatMap((item): { version: string; publishedAt: string | null }[] => {
      if (typeof item !== "object" || item === null) return [];
      const release = item as Record<string, unknown>;
      if (release.draft === true || release.prerelease === true || typeof release.tag_name !== "string") return [];
      const match = release.tag_name.match(/^v(\d+\.\d+\.\d+)$/);
      if (!match || compareDocumentationVersions(match[1], FIRST_DYNAMIC_DOCUMENTATION_VERSION) < 0) return [];
      return [{
        version: match[1],
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      }];
    });
    return json({ releases }, 200, {
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    });
  } catch {
    return json({ releases: [{ version: RELEASE_VERSION, publishedAt: null }] }, 200, {
      "Cache-Control": "public, max-age=30, s-maxage=60",
    });
  }
}

async function documentationContent(url: URL): Promise<Response> {
  const version = url.searchParams.get("version") ?? "";
  if (!DOCUMENTATION_VERSION_PATTERN.test(version) || compareDocumentationVersions(version, FIRST_DYNAMIC_DOCUMENTATION_VERSION) < 0) {
    return json({ error: "documentation version not found" }, 404);
  }
  const source = `https://raw.githubusercontent.com/TeoSlayer/shell.online/v${version}/docs/content.json`;
  try {
    const response = await fetch(source, {
      headers: { Accept: "application/json", "User-Agent": "shell.online" },
      cf: { cacheEverything: true, cacheTtl: 3_600 },
    });
    if (!response.ok) return json({ error: "documentation version not found" }, 404);
    const body = await response.text();
    if (body.length > 128 * 1024) return json({ error: "documentation is too large" }, 502);
    const parsed = JSON.parse(body) as { version?: unknown; pages?: unknown };
    if (parsed.version !== version || typeof parsed.pages !== "object" || parsed.pages === null) {
      return json({ error: "invalid documentation release" }, 502);
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch {
    return json({ error: "documentation version unavailable" }, 502);
  }
}

function compareDocumentationVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

async function handleStatsRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isStatsRequestHost(request, url)) {
    return secureStatsResponse(json({ error: "not found" }, 404));
  }

  const secureCookie = url.protocol === "https:";
  if (url.pathname === "/api/stats/logout" && request.method === "POST") {
    if (!hasSameOrigin(request, url)) {
      return secureStatsResponse(json({ error: "origin not allowed" }, 403));
    }
    return secureStatsResponse(json(
      { authenticated: false },
      200,
      { "Set-Cookie": clearStatsSessionCookie(secureCookie) },
    ));
  }

  const configuredPassword = statsPassword(env);
  if (configuredPassword === null) {
    return secureStatsResponse(json({ error: "dashboard password is not configured" }, 503));
  }

  if (url.pathname === "/api/stats/login" && request.method === "POST") {
    if (!hasSameOrigin(request, url)) {
      return secureStatsResponse(json({ error: "origin not allowed" }, 403));
    }
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > 1_024) {
      return secureStatsResponse(json({ error: "request too large" }, 413));
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const allowed = await env.STATS_AUTH_LIMITER.limit({ key: `login:${ip}` });
    if (!allowed.success) {
      return secureStatsResponse(json(
        { error: "too many attempts" },
        429,
        { "Retry-After": "60" },
      ));
    }

    let body: StatsLoginBody;
    try {
      body = (await request.json()) as StatsLoginBody;
    } catch {
      return secureStatsResponse(json({ error: "invalid credentials" }, 401));
    }
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    if (!await verifyStatsPassword(suppliedPassword, configuredPassword)) {
      return secureStatsResponse(json({ error: "invalid credentials" }, 401));
    }

    const session = await createStatsSession(configuredPassword);
    return secureStatsResponse(json(
      { authenticated: true },
      200,
      { "Set-Cookie": createStatsSessionCookie(session, secureCookie) },
    ));
  }

  const authenticated = await verifyStatsSession(
    readStatsSessionCookie(request),
    configuredPassword,
  );
  if (url.pathname === "/api/stats/auth" && request.method === "GET") {
    return secureStatsResponse(json({ authenticated }));
  }

  if (url.pathname === "/api/stats" && request.method === "GET") {
    if (!authenticated) {
      return secureStatsResponse(json({ error: "authentication required" }, 401));
    }
    const requestedRange = url.searchParams.get("range");
    const response = await fetchStatsSnapshot(
      env.STATS,
      isStatsRange(requestedRange) ? requestedRange : "7d",
    );
    return secureStatsResponse(response);
  }

  return secureStatsResponse(json({ error: "not found" }, 404));
}

function statsPassword(env: Env): string | null {
  return typeof env.STATS_PASSWORD === "string" && env.STATS_PASSWORD.length >= 12
    ? env.STATS_PASSWORD
    : null;
}

function hasSameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === requestOrigin(request, url);
}

function recordAnalytics(
  env: Env,
  waitUntilContext: WaitUntilContext,
  event: AnalyticsEvent,
  target: string,
  analyticsContext: AnalyticsContext = {},
): void {
  writeAnalytics(env.ANALYTICS, event, target, analyticsContext);
  waitUntilContext.waitUntil(submitStatsEvent(env.STATS, event, target, analyticsContext));
}

function recordAssetAnalytics(
  request: Request,
  env: Env,
  url: URL,
  response: Response,
  executionContext: ExecutionContext,
): void {
  if (request.method !== "GET" || !response.ok) return;

  const context = requestAnalyticsContext(request);
  if (url.pathname === "/install") {
    recordAnalytics(env, executionContext, "installer_download", "script", context);
    return;
  }
  if (url.pathname === "/skill" || url.pathname === "/skill/") {
    recordAnalytics(env, executionContext, "skill_download", "skill", context);
    return;
  }

  const binaryTarget = binaryDownloadTarget(url.pathname);
  if (binaryTarget) {
    recordAnalytics(env, executionContext, "binary_download", binaryTarget, context);
    return;
  }

  if (!isDocumentNavigation(request)) return;
  if (isStatsHostname(url.hostname)) {
    recordAnalytics(env, executionContext, "stats_view", "dashboard", context);
    return;
  }
  const documentTarget = new Map([
    ["/", "landing"],
    ["/docs/", "docs"],
    ["/mobile/", "docs_mobile"],
    ["/reliability/", "docs_reliability"],
    ["/security/", "docs_security"],
    ["/e2ee/", "docs_e2ee"],
    ["/docker/", "docs_docker"],
  ]).get(url.pathname);
  const target = documentTarget ?? (
    SESSION_ID_PATTERN.test(url.pathname.replace(/^\/s\//, "").replace(/\/$/, ""))
      ? "session"
      : "not_found"
  );
  recordAnalytics(env, executionContext, "page_view", target, context);
}

async function recordEvent(
  request: Request,
  env: Env,
  url: URL,
  executionContext: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin === null || origin !== requestOrigin(request, url)) {
    return json({ error: "origin not allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 256) return json({ error: "request too large" }, 413);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const allowed = await env.EVENT_LIMITER.limit({ key: ip });
  if (!allowed.success) {
    return json({ error: "too many events" }, 429, { "Retry-After": "60" });
  }

  let body: EventBody;
  try {
    body = (await request.json()) as EventBody;
  } catch {
    return json({ error: "invalid event" }, 400);
  }

  if (
    body.event !== "copy" ||
    (
      body.target !== "install" &&
      body.target !== "brew_install" &&
      body.target !== "source_build" &&
      body.target !== "run" &&
      body.target !== "share" &&
      body.target !== "skill"
    )
  ) {
    return json({ error: "invalid event" }, 400);
  }

  recordAnalytics(
    env,
    executionContext,
    "copy",
    body.target,
    requestAnalyticsContext(request),
  );

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

async function createSession(
  request: Request,
  env: Env,
  url: URL,
  executionContext: ExecutionContext,
): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 4_096) return json({ error: "request too large" }, 413);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const allowed = await env.SESSION_CREATION_LIMITER.limit({ key: ip });
  if (!allowed.success) {
    return json({ error: "too many sessions created" }, 429, { "Retry-After": "60" });
  }

  let body: CreateSessionBody = {};
  try {
    body = (await request.json()) as CreateSessionBody;
  } catch {
    // An empty or malformed body simply uses the default label.
  }

  if (body.read_only !== undefined && typeof body.read_only !== "boolean") {
    return json({ error: "read_only must be a boolean" }, 400);
  }
  if (body.encrypted !== undefined && typeof body.encrypted !== "boolean") {
    return json({ error: "encrypted must be a boolean" }, 400);
  }
  if (body.persistent !== undefined && typeof body.persistent !== "boolean") {
    return json({ error: "persistent must be a boolean" }, 400);
  }

  const label = sanitizeLabel(body.label);
  const readOnly = body.read_only === true;
  const encrypted = body.encrypted === true;
  const persistent = body.persistent === true;
  if (persistent) {
    return json({ error: "persistent sessions require saved client credentials" }, 400);
  }
  const sessionId = randomToken(24);
  const hostToken = randomToken(32);
  const createdAt = Date.now();
  const expiresAt = createdAt + (persistent ? PERSISTENT_TTL_MS : SESSION_TTL_MS);
  const hostTokenHash = await sha256Hex(hostToken);

  const stub = env.SESSIONS.getByName(sessionId);
  const initializeResponse = await stub.fetch("https://session.internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostTokenHash,
      readOnly,
      encrypted,
      persistent,
      label,
      createdAt,
      expiresAt,
    } satisfies InitializeSessionBody),
  });

  if (!initializeResponse.ok) {
    return json({ error: "could not create session" }, 500);
  }

  recordAnalytics(
    env,
    executionContext,
    "session_created",
    "cli",
    requestAnalyticsContext(request),
  );

  const origin = requestOrigin(request, url);
  const publicUrl = new URL(origin);
  const websocketProtocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  const shareUrl = `${origin}/s/${sessionId}`;
  const websocketUrl = `${websocketProtocol}//${publicUrl.host}/api/sessions/${sessionId}/ws`;

  return json(
    {
      session_id: sessionId,
      share_url: shareUrl,
      websocket_url: websocketUrl,
      host_token: hostToken,
      read_only: readOnly,
      encrypted,
      persistent,
      expires_at: new Date(expiresAt).toISOString(),
    },
    201,
    { "Cache-Control": "no-store" },
  );
}

async function resumeSession(
  request: Request,
  env: Env,
  url: URL,
  executionContext: ExecutionContext,
): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 4_096) return json({ error: "request too large" }, 413);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const allowed = await env.SESSION_CREATION_LIMITER.limit({ key: ip });
  if (!allowed.success) return json({ error: "too many sessions resumed" }, 429, { "Retry-After": "60" });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid session" }, 400); }
  const sessionId = body.session_id;
  const hostToken = body.host_token;
  if (
    typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId) ||
    typeof hostToken !== "string" || hostToken.length < 32 || hostToken.length > 128 ||
    typeof body.read_only !== "boolean" || typeof body.encrypted !== "boolean"
  ) return json({ error: "invalid persistent session" }, 400);
  const expectedSessionId = await persistentSessionID(hostToken);
  if (!constantTimeEqual(sessionId, expectedSessionId)) {
    return json({ error: "persistent credentials rejected" }, 403);
  }
  const createdAt = Date.now();
  const expiresAt = createdAt + PERSISTENT_TTL_MS;
  const stub = env.SESSIONS.getByName(sessionId);
  const resumed = await stub.fetch("https://session.internal/internal/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostTokenHash: await sha256Hex(hostToken),
      readOnly: body.read_only,
      encrypted: body.encrypted,
      persistent: true,
      label: sanitizeLabel(body.label),
      createdAt,
      expiresAt,
    } satisfies InitializeSessionBody),
  });
  if (!resumed.ok) return json({ error: resumed.status === 403 ? "persistent credentials rejected" : "could not resume session" }, resumed.status);
  const resumeResult = await resumed.json<{ created?: unknown }>();
  if (resumeResult.created === true) {
    recordAnalytics(env, executionContext, "session_created", "persistent_cli", requestAnalyticsContext(request));
  }
  const origin = requestOrigin(request, url);
  return json({
    session_id: sessionId,
    share_url: `${origin}/s/${sessionId}`,
    websocket_url: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/api/sessions/${sessionId}/ws`,
    host_token: hostToken,
    read_only: body.read_only,
    encrypted: body.encrypted,
    persistent: true,
    expires_at: new Date(expiresAt).toISOString(),
  }, 201, { "Cache-Control": "no-store" });
}

export class TerminalSession extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private meta: SessionMeta | undefined;
  private readonly traffic = new Map<string, TrafficWindow>();
  private readonly endedSockets = new WeakSet<WebSocket>();
  private lastPresenceSyncAt = 0;
  private presenceUpdate = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.meta = await state.storage.get<SessionMeta>("meta");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/init" && request.method === "POST") {
      return this.initialize(request);
    }
    if (url.pathname === "/internal/resume" && request.method === "POST") {
      return this.resume(request);
    }

    if (url.pathname === "/internal/status" && request.method === "GET") {
      if (this.meta === undefined) {
        return json({ exists: false }, 404, { "Cache-Control": "no-store" });
      }
      if (Date.now() >= this.meta.expiresAt) {
        await this.expire();
        return json({ exists: false }, 404, { "Cache-Control": "no-store" });
      }
      return json(
        { exists: true, status: this.meta.status, read_only: this.isReadOnly(), encrypted: this.isEncrypted() },
        200,
        { "Cache-Control": "no-store" },
      );
    }

    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "not found" }, 404);
    }

    return this.acceptSocket(request);
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.meta !== undefined) return json({ error: "session already exists" }, 409);

    let body: InitializeSessionBody;
    try {
      body = (await request.json()) as InitializeSessionBody;
    } catch {
      return json({ error: "invalid session" }, 400);
    }

    if (
      !/^[a-f0-9]{64}$/.test(body.hostTokenHash) ||
      typeof body.readOnly !== "boolean" ||
      typeof body.encrypted !== "boolean" ||
      typeof body.persistent !== "boolean" ||
      !Number.isSafeInteger(body.createdAt) ||
      !Number.isSafeInteger(body.expiresAt) ||
      body.expiresAt <= body.createdAt
    ) {
      return json({ error: "invalid session" }, 400);
    }

    this.meta = {
      hostTokenHash: body.hostTokenHash,
      readOnly: body.readOnly,
      encrypted: body.encrypted,
      persistent: body.persistent,
      label: sanitizeLabel(body.label),
      createdAt: body.createdAt,
      expiresAt: body.expiresAt,
      status: "waiting",
      presenceKey: randomToken(16),
    };
    await this.state.storage.put("meta", this.meta);
    await this.state.storage.setAlarm(this.meta.expiresAt);
    return json({ ok: true });
  }

  private async resume(request: Request): Promise<Response> {
    let body: InitializeSessionBody;
    try { body = await request.json() as InitializeSessionBody; } catch { return json({ error: "invalid session" }, 400); }
    if (!/^[a-f0-9]{64}$/.test(body.hostTokenHash) || !body.persistent) return json({ error: "invalid session" }, 400);
    if (this.meta && (
      !constantTimeEqual(this.meta.hostTokenHash, body.hostTokenHash) ||
      this.meta.readOnly !== body.readOnly || this.meta.encrypted !== body.encrypted || !this.meta.persistent
    )) return json({ error: "persistent credentials rejected" }, 403);
    const created = !this.meta;
    if (!this.meta) {
      this.meta = {
        hostTokenHash: body.hostTokenHash,
        readOnly: body.readOnly,
        encrypted: body.encrypted,
        persistent: true,
        label: sanitizeLabel(body.label),
        createdAt: body.createdAt,
        runStartedAt: body.createdAt,
        expiresAt: body.expiresAt,
        status: "waiting",
        presenceKey: randomToken(16),
      };
    } else {
      this.meta.expiresAt = body.expiresAt;
      this.meta.label = sanitizeLabel(body.label);
      this.meta.runStartedAt = body.createdAt;
      if (this.meta.status === "exited") this.meta.status = "waiting";
    }
    await this.persistMeta();
    await this.state.storage.setAlarm(this.meta.expiresAt);
    return json({ ok: true, created });
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (this.meta === undefined) return json({ error: "session not found" }, 404);
    if (Date.now() >= this.meta.expiresAt) {
      await this.expire();
      return json({ error: "session expired" }, 410);
    }

    const authorization = request.headers.get("Authorization");
    let role: SocketRole = "viewer";
    if (authorization !== null) {
      if (!authorization.startsWith("Bearer ")) return json({ error: "invalid host token" }, 401);
      const suppliedHash = await sha256Hex(authorization.slice("Bearer ".length));
      if (!constantTimeEqual(suppliedHash, this.meta.hostTokenHash)) {
        return json({ error: "invalid host token" }, 401);
      }
      role = "host";
    }

    if (
      role === "viewer" &&
      this.state.getWebSockets("viewer").filter((socket) => socket.readyState === 1).length >= MAX_VIEWERS
    ) {
      return json({ error: "session is full" }, 429);
    }

    if (role === "host") {
      for (const existing of this.state.getWebSockets("host")) {
        safeClose(existing, 4001, "host reconnected");
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const guestNumber = role === "viewer" ? this.nextGuestNumber() : undefined;
    const analyticsContext = requestAnalyticsContext(request);
    const attachment: SocketAttachment = {
      role,
      id: role === "viewer" ? randomUint32() : 0,
      guestNumber,
      colorIndex: guestNumber === undefined ? undefined : (guestNumber - 1) % 8,
      device: analyticsContext.device,
      client: analyticsContext.client,
      referrer: analyticsContext.referrer,
    };

    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [role]);

    if (role === "host") {
      const firstStart = this.meta.startedAt === undefined;
      if (firstStart) this.meta.startedAt = Date.now();
      this.meta.status = "connected";
      this.meta.expiresAt = Date.now() + (this.meta.persistent ? PERSISTENT_TTL_MS : SESSION_TTL_MS);
      delete this.meta.exitCode;
      await this.persistMeta();
      if (firstStart) {
        recordAnalytics(this.env, this.state, "session_started", "cli", analyticsContext);
      }
      await this.refreshLivePresence(true);
      await this.scheduleNextAlarm();
      this.broadcastStatus();

      for (const viewer of this.state.getWebSockets("viewer")) {
        const viewerAttachment = readAttachment(viewer);
        if (viewerAttachment) {
          sendJson(server, { type: "snapshot_request", viewerId: viewerAttachment.id });
        }
      }
    } else {
      const viewerCount = this.state
        .getWebSockets("viewer")
        .filter((socket) => socket.readyState === 1).length;
      const firstShareOpen = this.meta.shareOpenedAt === undefined;
      if (firstShareOpen) this.meta.shareOpenedAt = Date.now();
      this.meta.peakViewers = Math.max(this.meta.peakViewers ?? 0, viewerCount, 1);
      await this.persistMeta();
      recordAnalytics(this.env, this.state, "viewer_connected", "viewer", analyticsContext);
      if (firstShareOpen) {
        recordAnalytics(this.env, this.state, "share_opened", "viewer", analyticsContext);
      }
      await this.refreshLivePresence(true);
      await this.scheduleNextAlarm();
      sendJson(server, this.statusMessage());
      sendJson(server, {
        type: "welcome",
        viewerId: attachment.id,
        readOnly: this.isReadOnly(),
        encrypted: this.isEncrypted(),
      });
      for (const host of this.state.getWebSockets("host")) {
        sendJson(host, { type: "snapshot_request", viewerId: attachment.id });
      }
      this.broadcastPresence();
      this.rebalanceResizeOwner();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      safeClose(socket, 4002, "invalid connection state");
      return;
    }

    if (typeof message === "string") {
      await this.handleTextMessage(socket, attachment, message);
      return;
    }

    const frame = new Uint8Array(message);
    if (frame.byteLength < 1) {
      safeClose(socket, 4002, "empty frame");
      return;
    }

    const byteLimit = attachment.role === "host" ? HOST_WINDOW_BYTES : VIEWER_WINDOW_BYTES;
    if (!this.allowTraffic(`${attachment.role}:${attachment.id}`, frame.byteLength, byteLimit)) {
      safeClose(socket, 4008, "traffic limit exceeded");
      return;
    }

    if (attachment.role === "host") {
      await this.handleHostFrame(socket, frame);
    } else {
      this.handleViewerFrame(socket, attachment, frame);
    }
  }

  private async handleTextMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: string,
  ): Promise<void> {
    if (message.length > 1_024) {
      safeClose(socket, 4002, "unexpected text frame");
      return;
    }

    let event: { type?: unknown; code?: unknown; attached?: unknown };
    try {
      event = JSON.parse(message) as { type?: unknown; code?: unknown };
    } catch {
      safeClose(socket, 4002, "invalid control message");
      return;
    }

    if (attachment.role === "viewer") {
      if (event.type === "snapshot_request") {
        const now = Date.now();
        if (now - (attachment.snapshotRequestedAt ?? 0) < 1_000) return;
        attachment.snapshotRequestedAt = now;
        socket.serializeAttachment(attachment);
        for (const host of this.state.getWebSockets("host")) {
          sendJson(host, { type: "snapshot_request", viewerId: attachment.id });
        }
        return;
      }
      if (event.type !== "typing") {
        safeClose(socket, 4002, "unknown viewer control message");
        return;
      }
      if (this.isReadOnly()) return;
      this.claimInputLease(socket, attachment);
      return;
    }

    if (event.type === "local_typing") {
      const now = Date.now();
      if (now - (attachment.localTypingAt ?? 0) < 400) return;
      attachment.localTypingAt = now;
      socket.serializeAttachment(attachment);
      this.broadcastPresence();
      return;
    }

    if (event.type === "local_attached" && typeof event.attached === "boolean") {
      if (!this.meta) return;
      this.meta.localAttached = event.attached;
      await this.persistMeta();
      this.rebalanceResizeOwner();
      return;
    }

    if (event.type !== "exit") {
      safeClose(socket, 4002, "unknown control message");
      return;
    }

    const exitCode = Number(event.code);
    if (this.meta!.persistent) {
      this.meta!.status = "disconnected";
      this.meta!.expiresAt = Date.now() + PERSISTENT_TTL_MS;
      this.recordSessionEnd("persistent_task_exit");
      await this.persistMeta();
      await this.scheduleNextAlarm();
      this.broadcastStatus();
      sendJson(socket, { type: "exit_ack" });
      safeClose(socket, 4000, "task finished");
      return;
    }
    this.meta!.status = "exited";
    this.meta!.exitCode = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 1;
    const presenceKey = this.meta!.presenceKey;
    this.recordSessionEnd("task_exit");
    this.broadcastStatus();
    sendJson(socket, { type: "exit_ack" });
    const connectedSockets = this.state.getWebSockets();
    this.meta = undefined;
    await this.state.storage.deleteAll();
    await this.clearLivePresence(presenceKey);
    for (const connected of connectedSockets) safeClose(connected, 4000, "task finished");
    this.traffic.clear();
  }

  private async handleHostFrame(socket: WebSocket, frame: Uint8Array): Promise<void> {
    this.deferPresenceRefresh();
    switch (frame[0]) {
      case Opcode.Output:
        if (frame.byteLength > MAX_LIVE_FRAME_BYTES + 1 + (this.isEncrypted() ? MAX_ENCRYPTION_OVERHEAD_BYTES : 0)) {
          safeClose(socket, 4009, "output frame too large");
          return;
        }
        this.broadcastBinary(frame, "viewer");
        return;

      case Opcode.Snapshot: {
        if (frame.byteLength < 5 || frame.byteLength > MAX_SNAPSHOT_BYTES + 5 + (this.isEncrypted() ? MAX_ENCRYPTION_OVERHEAD_BYTES : 0)) {
          safeClose(socket, 4009, "snapshot frame too large");
          return;
        }
        const targetId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
        const target = this.state
          .getWebSockets("viewer")
          .find((candidate) => readAttachment(candidate)?.id === targetId);
        if (target) {
          const outbound = new Uint8Array(frame.byteLength - 4);
          outbound[0] = Opcode.Snapshot;
          outbound.set(frame.subarray(5), 1);
          safeSend(target, outbound);
        }
        return;
      }

      case Opcode.FinalSnapshot:
        if (frame.byteLength > MAX_SNAPSHOT_BYTES + 1 + (this.isEncrypted() ? MAX_ENCRYPTION_OVERHEAD_BYTES : 0)) {
          safeClose(socket, 4009, "final snapshot too large");
          return;
        }
        // Preserve the opcode because E2EE authenticates it as associated data.
        // The browser treats FinalSnapshot as a full screen replacement too.
        this.broadcastBinary(frame, "viewer");
        return;

      case Opcode.BroadcastSnapshot:
        if (frame.byteLength > MAX_SNAPSHOT_BYTES + 1 + (this.isEncrypted() ? MAX_ENCRYPTION_OVERHEAD_BYTES : 0)) {
          safeClose(socket, 4009, "broadcast snapshot too large");
          return;
        }
        {
          const snapshot = new Uint8Array(frame.byteLength);
          snapshot[0] = Opcode.Snapshot;
          snapshot.set(frame.subarray(1), 1);
          this.broadcastBinary(snapshot, "viewer");
        }
        return;

      case Opcode.Pong:
        if (frame.byteLength !== (this.isEncrypted() ? 34 : 5)) {
          safeClose(socket, 4002, "invalid latency response");
          return;
        }
        this.broadcastBinary(frame, "viewer");
        return;

      default:
        safeClose(socket, 4002, "host opcode not allowed");
    }
  }

  private handleViewerFrame(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: Uint8Array,
  ): void {
    this.deferPresenceRefresh();
    const action = viewerFrameAction(frame[0], this.isReadOnly());
    if (action === "blocked-input") {
      sendJson(socket, { type: "access_denied", reason: "read_only" });
      return;
    }

    if (action === "input") {
      if (frame.byteLength > MAX_INPUT_FRAME_BYTES + (this.isEncrypted() ? MAX_ENCRYPTION_OVERHEAD_BYTES : 0)) {
        safeClose(socket, 4009, "input frame too large");
        return;
      }
      if (!this.claimInputLease(socket, attachment, true)) return;
      this.broadcastBinary(frame, "host");
      this.recordCollaborationStarted(attachment);
      return;
    }

    if (action === "resize") {
      if (this.isEncrypted()) {
        if (frame.byteLength !== 34) {
          safeClose(socket, 4002, "invalid encrypted terminal size");
          return;
        }
        if (attachment.resizeOwner === true) this.broadcastBinary(frame, "host");
        return;
      }
      const size = decodeResize(frame);
      if (!size || size.cols < 10 || size.cols > 500 || size.rows < 4 || size.rows > 300) {
        safeClose(socket, 4002, "invalid terminal size");
        return;
      }
      attachment.cols = size.cols;
      attachment.rows = size.rows;
      socket.serializeAttachment(attachment);
      if (attachment.resizeOwner === true) this.broadcastBinary(frame, "host");
      return;
    }

    if (action === "ping") {
      if (frame.byteLength !== (this.isEncrypted() ? 34 : 5)) {
        safeClose(socket, 4002, "invalid latency probe");
        return;
      }
      this.broadcastBinary(frame, "host");
      return;
    }

    safeClose(socket, 4002, "viewer opcode not allowed");
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.handleSocketEnd(socket);
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    await this.handleSocketEnd(socket);
  }

  private async handleSocketEnd(socket: WebSocket): Promise<void> {
    if (this.endedSockets.has(socket)) return;
    this.endedSockets.add(socket);
    const attachment = readAttachment(socket);
    if (!attachment || attachment.ended) return;
    attachment.ended = true;
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // The socket may already be fully detached; the in-memory callback is still handled once.
    }
    if (attachment?.role === "viewer") {
      recordAnalytics(this.env, this.state, "viewer_disconnected", "viewer", {
        device: attachment.device,
        client: attachment.client,
        referrer: attachment.referrer,
      });
      await this.refreshLivePresence(true, socket);
      await this.scheduleNextAlarm();
      this.broadcastPresence(socket);
      this.rebalanceResizeOwner(socket);
      return;
    }
    if (attachment?.role !== "host" || !this.meta || this.meta.status === "exited") return;

    const anotherHostIsOpen = this.state
      .getWebSockets("host")
      .some((candidate) => candidate !== socket && candidate.readyState === 1);
    if (anotherHostIsOpen) {
      await this.refreshLivePresence(true, socket);
      return;
    }
    this.meta.status = "disconnected";
    this.meta.expiresAt = Date.now() + (this.meta.persistent ? PERSISTENT_TTL_MS : DISCONNECTED_GRACE_MS);
    await this.persistMeta();
    await this.refreshLivePresence(true, socket);
    await this.scheduleNextAlarm();
    this.broadcastStatus();
  }

  async alarm(): Promise<void> {
    if (!this.meta) return;
    const hostIsOpen = this.state
      .getWebSockets("host")
      .some((socket) => socket.readyState === 1);
    if (hostIsOpen) {
      this.meta.status = "connected";
      this.meta.expiresAt = Date.now() + (this.meta.persistent ? PERSISTENT_TTL_MS : SESSION_TTL_MS);
      await this.persistMeta();
      await this.refreshLivePresence(true);
      await this.scheduleNextAlarm();
      this.broadcastStatus();
      return;
    }

    if (this.meta.persistent) {
      if (Date.now() >= this.meta.expiresAt) {
        await this.expire();
        return;
      }
      this.meta.status = "disconnected";
      await this.persistMeta();
      await this.refreshLivePresence(true);
      await this.scheduleNextAlarm();
      this.broadcastStatus();
      return;
    }

    if (this.meta.status === "connected") {
      this.meta.status = "disconnected";
      this.meta.expiresAt = Date.now() + DISCONNECTED_GRACE_MS;
      await this.persistMeta();
      this.broadcastStatus();
    }
    if (Date.now() < this.meta.expiresAt) {
      await this.refreshLivePresence(true);
      await this.scheduleNextAlarm();
      return;
    }
    await this.expire();
  }

  private async expire(): Promise<void> {
    const connectedSockets = this.state.getWebSockets();
    const presenceKey = this.meta?.presenceKey;
    if (this.meta) {
      const outcome = this.meta.status === "waiting"
        ? "never_started"
        : this.meta.status === "disconnected"
          ? "disconnected_timeout"
          : "expired";
      this.recordSessionEnd(outcome);
    }
    this.meta = undefined;
    await this.state.storage.deleteAll();
    await this.clearLivePresence(presenceKey);
    for (const socket of connectedSockets) safeClose(socket, 4004, "session expired");
    this.traffic.clear();
  }

  private allowTraffic(key: string, byteCount: number, byteLimit: number): boolean {
    const now = Date.now();
    let window = this.traffic.get(key);
    if (!window || now - window.startedAt >= TRAFFIC_WINDOW_MS) {
      window = { startedAt: now, bytes: 0, frames: 0 };
      this.traffic.set(key, window);
    }

    window.bytes += byteCount;
    window.frames += 1;
    return window.bytes <= byteLimit && window.frames <= MAX_FRAMES_PER_WINDOW;
  }

  private async persistMeta(): Promise<void> {
    if (this.meta) await this.state.storage.put("meta", this.meta);
  }

  private deferPresenceRefresh(): void {
    if (Date.now() - this.lastPresenceSyncAt < STATS_PRESENCE_REFRESH_MS) return;
    this.state.waitUntil(
      this.refreshLivePresence().then(() => this.scheduleNextAlarm()),
    );
  }

  private refreshLivePresence(force = false, excluded?: WebSocket): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPresenceSyncAt < STATS_PRESENCE_REFRESH_MS) {
      return this.presenceUpdate;
    }
    this.lastPresenceSyncAt = now;
    const previousUpdate = this.presenceUpdate.catch(() => undefined);
    this.presenceUpdate = previousUpdate.then(async () => {
      const meta = this.meta;
      if (!meta) return;
      if (!meta.presenceKey) {
        meta.presenceKey = randomToken(16);
        await this.state.storage.put("meta", meta);
      }
      const hostIsOpen = this.state
        .getWebSockets("host")
        .some((socket) => socket !== excluded && socket.readyState === 1);
      const activeViewers = this.state
        .getWebSockets("viewer")
        .filter((socket) => socket !== excluded && socket.readyState === 1)
        .length;
      await updateStatsPresence(
        this.env.STATS,
        meta.presenceKey,
        hostIsOpen && meta.status === "connected" ? 1 : 0,
        activeViewers,
      );
    });
    return this.presenceUpdate;
  }

  private async clearLivePresence(presenceKey?: string): Promise<void> {
    await this.presenceUpdate.catch(() => undefined);
    if (presenceKey) await removeStatsPresence(this.env.STATS, presenceKey);
    this.lastPresenceSyncAt = 0;
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.meta) return;
    const hasLiveSockets = this.state
      .getWebSockets()
      .some((socket) => socket.readyState === 1);
    const nextAlarm = hasLiveSockets
      ? Math.min(this.meta.expiresAt, Date.now() + STATS_PRESENCE_REFRESH_MS)
      : this.meta.expiresAt;
    await this.state.storage.setAlarm(nextAlarm);
  }

  private recordCollaborationStarted(attachment: SocketAttachment): void {
    if (!this.meta || this.meta.collaborationStartedAt !== undefined) return;
    this.meta.collaborationStartedAt = Date.now();
    recordAnalytics(this.env, this.state, "collaboration_started", "remote_input", {
      device: attachment.device,
      client: attachment.client,
      referrer: "internal",
    });
    const meta = { ...this.meta };
    this.state.waitUntil(this.state.storage.put("meta", meta));
  }

  private recordSessionEnd(outcome: string): void {
    if (!this.meta) return;
    const durationSeconds = Math.max(0, (Date.now() - (this.meta.runStartedAt ?? this.meta.createdAt)) / 1_000);
    recordAnalytics(this.env, this.state, "session_ended", outcome, {
      device: "cli",
      client: "shell",
      referrer: "direct",
      value: durationSeconds,
      auxiliary: this.meta.peakViewers ?? 0,
    });
  }

  private statusMessage(): Record<string, unknown> {
    return {
      type: "status",
      status: this.meta?.status ?? "disconnected",
      label: this.meta?.label ?? "terminal",
      readOnly: this.isReadOnly(),
      encrypted: this.isEncrypted(),
      persistent: this.meta?.persistent === true,
      exitCode: this.meta?.exitCode,
      expiresAt: this.meta ? new Date(this.meta.expiresAt).toISOString() : undefined,
    };
  }

  private isReadOnly(): boolean {
    return this.meta?.readOnly === true;
  }

  private isEncrypted(): boolean {
    return this.meta?.encrypted === true;
  }

  private broadcastStatus(): void {
    const message = JSON.stringify(this.statusMessage());
    for (const viewer of this.state.getWebSockets("viewer")) safeSend(viewer, message);
  }

  private nextGuestNumber(): number {
    const used = new Set(
      this.state
        .getWebSockets("viewer")
        .filter((socket) => socket.readyState === 1)
        .map((socket) => readAttachment(socket)?.guestNumber)
        .filter((value): value is number => typeof value === "number"),
    );
    for (let number = 1; number <= MAX_VIEWERS; number += 1) {
      if (!used.has(number)) return number;
    }
    return MAX_VIEWERS;
  }

  private claimInputLease(
    socket: WebSocket,
    attachment: SocketAttachment,
    deferPresence = false,
  ): boolean {
    const now = Date.now();
    const localTypingIsActive = this.state
      .getWebSockets("host")
      .filter((candidate) => candidate.readyState === 1)
      .map((candidate) => readAttachment(candidate)?.localTypingAt)
      .some((typingAt) => typingAt !== undefined && now - typingAt < TYPING_LEASE_MS);
    if (localTypingIsActive) return false;

    const activeTypist = this.state
      .getWebSockets("viewer")
      .filter((candidate) => candidate.readyState === 1)
      .map((candidate) => readAttachment(candidate))
      .filter(
        (candidate): candidate is SocketAttachment =>
          candidate?.role === "viewer" &&
          candidate.typingAt !== undefined &&
          now - candidate.typingAt < TYPING_LEASE_MS,
      )
      .sort((left, right) => (right.typingAt ?? 0) - (left.typingAt ?? 0))[0];

    if (activeTypist && activeTypist.id !== attachment.id) return false;
    if (now - (attachment.typingAt ?? 0) < 400) return true;

    attachment.typingAt = now;
    socket.serializeAttachment(attachment);
    this.rebalanceResizeOwner();
    if (deferPresence) {
      queueMicrotask(() => this.broadcastPresence());
    } else {
      this.broadcastPresence();
    }
    return true;
  }

  private broadcastPresence(excluded?: WebSocket): void {
    const viewers = this.state
      .getWebSockets("viewer")
      .filter((socket) => socket !== excluded && socket.readyState === 1)
      .map((socket) => readAttachment(socket))
      .filter((attachment): attachment is SocketAttachment => attachment?.role === "viewer")
      .map((attachment) => ({
        id: attachment.id,
        name: `Guest ${attachment.guestNumber ?? 1}`,
        color: attachment.colorIndex ?? 0,
        typingAt: attachment.typingAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const localTypingAt = this.state
      .getWebSockets("host")
      .filter((socket) => socket.readyState === 1)
      .map((socket) => readAttachment(socket)?.localTypingAt)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => right - left)[0];
    const message = JSON.stringify({ type: "presence", viewers, localTypingAt });
    for (const viewer of this.state.getWebSockets("viewer")) safeSend(viewer, message);
  }

  private broadcastBinary(frame: Uint8Array, role: SocketRole): void {
    for (const socket of this.state.getWebSockets(role)) safeSend(socket, frame);
  }

  private rebalanceResizeOwner(excluded?: WebSocket): void {
    const viewers = this.state
      .getWebSockets("viewer")
      .filter((socket) => socket !== excluded && socket.readyState === 1);
    const currentOwnerId = viewers
      .map((socket) => readAttachment(socket))
      .find((attachment) => attachment?.resizeOwner === true)?.id ?? null;
    const ownerId = this.meta?.localAttached === true
      ? null
      : chooseResizeOwner(
        viewers.map((socket) => {
          const attachment = readAttachment(socket)!;
          return {
            id: attachment.id,
            connected: true,
            guestNumber: attachment.guestNumber,
            typingAt: attachment.typingAt,
          };
        }),
        currentOwnerId,
        Date.now(),
        TYPING_LEASE_MS,
      );
    for (const viewer of viewers) {
      const attachment = readAttachment(viewer);
      if (!attachment) continue;
      const allowed = attachment.id === ownerId;
      if (attachment.resizeOwner === allowed) continue;
      attachment.resizeOwner = allowed;
      viewer.serializeAttachment(attachment);
      sendJson(viewer, { type: "resize_control", allowed });
    }
  }
}

function sanitizeLabel(value: unknown): string {
  if (typeof value !== "string") return "terminal";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return cleaned || "terminal";
}

function requestOrigin(request: Request, url: URL): string {
  const host = request.headers.get("Host");
  if (host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
    return `${url.protocol}//${host}`;
  }
  return url.origin;
}

function isStatsHostname(hostname: string): boolean {
  return hostname === "stats.shell.online" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
}

function isStatsRequestHost(request: Request, url: URL): boolean {
  if (isStatsHostname(url.hostname)) return true;
  const connectingIp = request.headers.get("CF-Connecting-IP");
  return url.protocol === "http:" &&
    (connectingIp === "127.0.0.1" || connectingIp === "::1");
}

function secureAssetResponse(response: Response, pathname: string, hostname: string): Response {
  const headers = new Headers(response.headers);
  const isHtmlDocument = headers.get("Content-Type")?.toLowerCase().startsWith("text/html") ?? false;
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' wss: ws:",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "));
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (
    pathname.startsWith("/s/") ||
    pathname.startsWith("/downloads/") ||
    pathname === "/install" ||
    pathname === "/skill" ||
    pathname === "/skill/" ||
    pathname === "/llms.txt" ||
    (isHtmlDocument && (!isPublicDocumentPath(pathname) || hostname !== "shell.online")) ||
    isStatsHostname(hostname)
  ) {
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  if (pathname === "/install") headers.set("Content-Type", "text/x-shellscript; charset=utf-8");
  if (pathname === "/llms.txt") headers.set("Content-Type", "text/plain; charset=utf-8");
  if (pathname === "/skill") {
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    headers.set("Content-Disposition", "attachment; filename=\"SKILL.md\"");
    headers.set("Cache-Control", "public, max-age=300");
  }
  if (isPublicDocumentPath(pathname) || pathname.startsWith("/s/") || isStatsHostname(hostname)) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isPublicDocumentPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/docs/" || pathname === "/mobile/" || pathname === "/reliability/" || pathname === "/security/" || pathname === "/e2ee/" || pathname === "/docker/";
}

function secureStatsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(
  value: unknown,
  status = 200,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...additionalHeaders,
    },
  });
}

function randomToken(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function readAttachment(socket: WebSocket): SocketAttachment | null {
  try {
    return socket.deserializeAttachment() as SocketAttachment;
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, value: unknown): void {
  safeSend(socket, JSON.stringify(value));
}

function safeSend(socket: WebSocket, value: string | ArrayBuffer | ArrayBufferView): void {
  try {
    if (socket.readyState === 1) socket.send(value);
  } catch {
    // A close racing a broadcast should not disrupt the rest of the session.
  }
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may already have disappeared.
  }
}
