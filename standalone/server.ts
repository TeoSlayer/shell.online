import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { Opcode, decodeResize } from "../shared/protocol";
import { viewerFrameAction } from "../shared/session-access";
import { viewerAdmission } from "../shared/session-capacity";
import { disconnectedSessionExpiry, PERSISTENT_TTL_MS, SESSION_TTL_MS } from "../shared/session-lifetime";
import { persistentSessionID } from "../shared/persistent-session";
import { terminalGridForDevices } from "../shared/terminal-grid";

const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;
const MAX_BODY = 4_096;
const MAX_LIVE_FRAME = 64 * 1024;
const MAX_INPUT_FRAME = 16 * 1024 + 1;
const MAX_SNAPSHOT = 512 * 1024;
const ENCRYPTION_OVERHEAD = 29;
const TRAFFIC_WINDOW_MS = 10_000;
const HOST_WINDOW_BYTES = 40 * 1024 * 1024;
const VIEWER_WINDOW_BYTES = 1024 * 1024;
const MAX_FRAMES_PER_WINDOW = 2_000;
const TYPING_LEASE_MS = 1_800;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

type Status = "waiting" | "connected" | "disconnected" | "exited";
type Role = "host" | "viewer";

interface SessionMeta {
  id: string;
  hostTokenHash: string;
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  label: string;
  createdAt: number;
  expiresAt: number;
  status: Status;
  exitCode?: number;
}

interface Attachment {
  role: Role;
  id: number;
  guestNumber?: number;
  colorIndex?: number;
  typingAt?: number;
  localTypingAt?: number;
  device?: string;
  portrait?: boolean;
  supportsPortraitGrid?: boolean;
  snapshotRequestedAt?: number;
  terminalCols?: number;
  terminalRows?: number;
}

interface TrafficWindow { startedAt: number; bytes: number; frames: number }

export interface StandaloneOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
  webRoot?: string;
  stateFile?: string;
  trustProxy?: boolean;
}

interface RuntimeConfig {
  host: string;
  port: number;
  publicUrl: URL;
  webRoot: string;
  stateFile: string;
  trustProxy: boolean;
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit: number, private readonly periodMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || now - current.startedAt >= this.periodMs) {
      if (!current && this.entries.size >= 10_000) {
        for (const [candidate, entry] of this.entries) {
          if (now - entry.startedAt >= this.periodMs) this.entries.delete(candidate);
        }
        if (this.entries.size >= 10_000) return false;
      }
      this.entries.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

class SessionStore {
  readonly sessions = new Map<string, SessionRelay>();

  constructor(private readonly stateFile: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.stateFile)) return;
    let records: unknown;
    try {
      records = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(`cannot read relay state ${this.stateFile}: ${String(error)}`);
    }
    if (!Array.isArray(records)) throw new Error(`invalid relay state ${this.stateFile}`);
    const now = Date.now();
    for (const value of records) {
      if (!validMeta(value) || value.expiresAt <= now) continue;
      value.status = "disconnected";
      this.sessions.set(value.id, new SessionRelay(value, this));
    }
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const records = [...this.sessions.values()].map((session) => session.meta);
    writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  add(meta: SessionMeta): SessionRelay {
    const relay = new SessionRelay(meta, this);
    this.sessions.set(meta.id, relay);
    this.save();
    return relay;
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.save();
  }

  sweep(): void {
    const now = Date.now();
    for (const relay of [...this.sessions.values()]) {
      if (relay.meta.expiresAt <= now && !relay.hasHost()) relay.expire();
    }
  }
}

class SessionRelay {
  readonly viewers = new Map<WebSocket, Attachment>();
  host: WebSocket | undefined;
  hostAttachment: Attachment | undefined;
  private readonly traffic = new Map<string, TrafficWindow>();

  constructor(public readonly meta: SessionMeta, private readonly store: SessionStore) {}

  hasHost(): boolean { return this.host?.readyState === WebSocket.OPEN; }

  persist(): void { this.store.save(); }

  accept(socket: WebSocket, request: IncomingMessage, role: Role): void {
    if (role === "host") {
      if (this.host && this.host !== socket) close(this.host, 4001, "host reconnected");
      this.host = socket;
      this.hostAttachment = {
        role,
        id: 0,
        supportsPortraitGrid: request.headers["x-shell-terminal-grid"] === "80x40",
      };
      this.meta.status = "connected";
      this.meta.expiresAt = Date.now() + (this.meta.persistent ? PERSISTENT_TTL_MS : SESSION_TTL_MS);
      delete this.meta.exitCode;
      this.persist();
      this.broadcastStatus();
      for (const viewer of this.viewers.values()) sendJSON(socket, { type: "snapshot_request", viewerId: viewer.id });
      this.broadcastGrid();
      this.bind(socket, this.hostAttachment);
      return;
    }

    const guestNumber = this.nextGuestNumber();
    const attachment: Attachment = {
      role,
      id: randomBytes(4).readUInt32BE(0),
      guestNumber,
      colorIndex: (guestNumber - 1) % 8,
      device: mobileUserAgent(request.headers["user-agent"]) ? "mobile" : "desktop",
      portrait: new URL(request.url ?? "/", "http://relay").searchParams.get("layout") === "portrait",
    };
    this.viewers.set(socket, attachment);
    sendJSON(socket, this.statusMessage());
    sendJSON(socket, { type: "welcome", viewerId: attachment.id, readOnly: this.meta.readOnly, encrypted: this.meta.encrypted });
    sendJSON(socket, { type: "resize_control", allowed: false });
    if (this.host) sendJSON(this.host, { type: "snapshot_request", viewerId: attachment.id });
    this.broadcastGrid();
    this.broadcastPresence();
    this.bind(socket, attachment);
  }

  private bind(socket: WebSocket, attachment: Attachment): void {
    socket.on("message", (data, binary) => this.onMessage(socket, attachment, data, binary));
    socket.once("close", () => this.onClose(socket, attachment));
    socket.once("error", () => this.onClose(socket, attachment));
  }

  private onMessage(socket: WebSocket, attachment: Attachment, raw: RawData, binary: boolean): void {
    if (!binary) {
      const value = raw.toString();
      if (value.length > 1_024) return close(socket, 4002, "unexpected text frame");
      this.handleText(socket, attachment, value);
      return;
    }
    const frame = rawData(raw);
    if (frame.length < 1) return close(socket, 4002, "empty frame");
    const limit = attachment.role === "host" ? HOST_WINDOW_BYTES : VIEWER_WINDOW_BYTES;
    if (!this.allowTraffic(`${attachment.role}:${attachment.id}`, frame.length, limit)) {
      return close(socket, 4008, "traffic limit exceeded");
    }
    if (attachment.role === "host") this.handleHostFrame(socket, frame);
    else this.handleViewerFrame(socket, attachment, frame);
  }

  private handleText(socket: WebSocket, attachment: Attachment, value: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(value) as Record<string, unknown>; }
    catch { return close(socket, 4002, "invalid control message"); }
    if (attachment.role === "viewer") {
      if (event.type === "viewer_layout" && typeof event.portrait === "boolean") {
        if (attachment.portrait === event.portrait) return;
        attachment.portrait = event.portrait;
        this.broadcastGrid();
        return;
      }
      if (event.type === "snapshot_request") {
        const now = Date.now();
        if (now - (attachment.snapshotRequestedAt ?? 0) < 1_000) return;
        attachment.snapshotRequestedAt = now;
        if (this.host) sendJSON(this.host, { type: "snapshot_request", viewerId: attachment.id });
        return;
      }
      if (event.type !== "typing") return close(socket, 4002, "unknown viewer control message");
      if (!this.meta.readOnly) this.claimInputLease(attachment);
      return;
    }
    if (event.type === "local_typing") {
      if (Date.now() - (attachment.localTypingAt ?? 0) >= 400) {
        attachment.localTypingAt = Date.now();
        this.broadcastPresence();
      }
      return;
    }
    if (event.type === "local_attached" && typeof event.attached === "boolean") return;
    if (event.type !== "exit") return close(socket, 4002, "unknown control message");
    if (this.meta.persistent) {
      this.meta.status = "disconnected";
      this.meta.expiresAt = Date.now() + PERSISTENT_TTL_MS;
      this.persist();
      this.broadcastStatus();
      sendJSON(socket, { type: "exit_ack" });
      return close(socket, 4000, "task finished");
    }
    const exitCode = Number(event.code);
    this.meta.status = "exited";
    this.meta.exitCode = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 1;
    this.broadcastStatus();
    sendJSON(socket, { type: "exit_ack" });
    this.expire(4000, "task finished");
  }

  private handleHostFrame(socket: WebSocket, frame: Buffer): void {
    switch (frame[0]) {
      case Opcode.Output:
        if (frame.length > MAX_LIVE_FRAME + 1 + (this.meta.encrypted ? ENCRYPTION_OVERHEAD : 0)) return close(socket, 4009, "output frame too large");
        return this.broadcastBinary(frame, "viewer");
      case Opcode.Snapshot: {
        if (frame.length < 5 || frame.length > MAX_SNAPSHOT + 5 + (this.meta.encrypted ? ENCRYPTION_OVERHEAD : 0)) return close(socket, 4009, "snapshot frame too large");
        const targetId = frame.readUInt32BE(1);
        const target = [...this.viewers.entries()].find(([, viewer]) => viewer.id === targetId)?.[0];
        if (target) {
          const outbound = Buffer.concat([Buffer.from([Opcode.Snapshot]), frame.subarray(5)]);
          send(target, outbound);
        }
        return;
      }
      case Opcode.FinalSnapshot:
      case Opcode.BroadcastSnapshot:
        if (frame.length > MAX_SNAPSHOT + 1 + (this.meta.encrypted ? ENCRYPTION_OVERHEAD : 0)) return close(socket, 4009, "snapshot frame too large");
        return this.broadcastBinary(frame, "viewer");
      case Opcode.Pong:
        if (frame.length !== (this.meta.encrypted ? 34 : 5)) return close(socket, 4002, "invalid latency response");
        return this.broadcastBinary(frame, "viewer");
      default:
        return close(socket, 4002, "host opcode not allowed");
    }
  }

  private handleViewerFrame(socket: WebSocket, attachment: Attachment, frame: Buffer): void {
    const action = viewerFrameAction(frame[0], this.meta.readOnly);
    if (action === "blocked-input") return sendJSON(socket, { type: "access_denied", reason: "read_only" });
    if (action === "input") {
      if (frame.length > MAX_INPUT_FRAME + (this.meta.encrypted ? ENCRYPTION_OVERHEAD : 0)) return close(socket, 4009, "input frame too large");
      if (!this.claimInputLease(attachment)) return;
      this.broadcastGrid();
      return this.broadcastBinary(frame, "host");
    }
    if (action === "confirmed-eof") {
      if (frame.length !== (this.meta.encrypted ? 30 : 1)) return close(socket, 4002, "invalid confirmed EOF frame");
      if (!this.claimInputLease(attachment)) return;
      this.broadcastGrid();
      return this.broadcastBinary(frame, "host");
    }
    if (action === "resize") {
      if (this.meta.encrypted) {
        if (frame.length !== 34) close(socket, 4002, "invalid encrypted terminal size");
        return;
      }
      const size = decodeResize(frame);
      if (!size || size.cols < 10 || size.cols > 500 || size.rows < 4 || size.rows > 300) close(socket, 4002, "invalid terminal size");
      return;
    }
    if (action === "ping") {
      if (frame.length !== (this.meta.encrypted ? 34 : 5)) return close(socket, 4002, "invalid latency probe");
      return this.broadcastBinary(frame, "host");
    }
    close(socket, 4002, "viewer opcode not allowed");
  }

  private onClose(socket: WebSocket, attachment: Attachment): void {
    if (attachment.role === "viewer") {
      if (!this.viewers.delete(socket)) return;
      this.broadcastGrid();
      this.broadcastPresence();
      return;
    }
    if (this.host !== socket) return;
    this.host = undefined;
    this.hostAttachment = undefined;
    if (this.meta.status === "exited") return;
    this.meta.status = "disconnected";
    this.meta.expiresAt = disconnectedSessionExpiry(Date.now(), this.meta.persistent);
    this.persist();
    this.broadcastStatus();
  }

  expire(code = 4004, reason = "session expired"): void {
    if (this.host) close(this.host, code, reason);
    for (const viewer of this.viewers.keys()) close(viewer, code, reason);
    this.host = undefined;
    this.viewers.clear();
    this.traffic.clear();
    this.store.delete(this.meta.id);
  }

  statusMessage(): Record<string, unknown> {
    return {
      type: "status", status: this.meta.status, label: this.meta.label,
      readOnly: this.meta.readOnly, encrypted: this.meta.encrypted, persistent: this.meta.persistent,
      exitCode: this.meta.exitCode, expiresAt: new Date(this.meta.expiresAt).toISOString(),
    };
  }

  private broadcastStatus(): void { for (const socket of this.viewers.keys()) sendJSON(socket, this.statusMessage()); }

  private nextGuestNumber(): number {
    const used = new Set([...this.viewers.values()].map((viewer) => viewer.guestNumber));
    for (let number = 1; number <= 16; number += 1) if (!used.has(number)) return number;
    return 16;
  }

  private claimInputLease(attachment: Attachment): boolean {
    const now = Date.now();
    if (this.hostAttachment?.localTypingAt && now - this.hostAttachment.localTypingAt < TYPING_LEASE_MS) return false;
    const active = [...this.viewers.values()]
      .filter((viewer) => viewer.typingAt && now - viewer.typingAt < TYPING_LEASE_MS)
      .sort((left, right) => (right.typingAt ?? 0) - (left.typingAt ?? 0))[0];
    if (active && active.id !== attachment.id) return false;
    if (now - (attachment.typingAt ?? 0) >= 400) {
      attachment.typingAt = now;
      this.broadcastPresence();
    }
    return true;
  }

  private broadcastPresence(): void {
    const viewers = [...this.viewers.values()].map((viewer) => ({
      id: viewer.id, name: `Guest ${viewer.guestNumber ?? 1}`, color: viewer.colorIndex ?? 0, typingAt: viewer.typingAt,
    })).sort((left, right) => left.name.localeCompare(right.name));
    const message = { type: "presence", viewers, localTypingAt: this.hostAttachment?.localTypingAt };
    for (const socket of this.viewers.keys()) sendJSON(socket, message);
  }

  private broadcastGrid(): void {
    const devices = [...this.viewers.values()].map((viewer) => viewer.portrait ? "portrait" : viewer.device ?? "unknown");
    const grid = terminalGridForDevices(devices, this.hostAttachment?.supportsPortraitGrid === true);
    const sockets: [WebSocket, Attachment][] = [...this.viewers.entries()];
    if (this.host && this.hostAttachment) sockets.push([this.host, this.hostAttachment]);
    for (const [socket, attachment] of sockets) {
      if (attachment.terminalCols === grid.cols && attachment.terminalRows === grid.rows) continue;
      attachment.terminalCols = grid.cols;
      attachment.terminalRows = grid.rows;
      sendJSON(socket, { type: "terminal_size", ...grid });
    }
  }

  private broadcastBinary(frame: Buffer, role: Role): void {
    if (role === "host") {
      if (this.host) send(this.host, frame);
      return;
    }
    for (const viewer of this.viewers.keys()) send(viewer, frame);
  }

  private allowTraffic(key: string, bytes: number, byteLimit: number): boolean {
    const now = Date.now();
    let window = this.traffic.get(key);
    if (!window || now - window.startedAt >= TRAFFIC_WINDOW_MS) {
      window = { startedAt: now, bytes: 0, frames: 0 };
      this.traffic.set(key, window);
    }
    window.bytes += bytes;
    window.frames += 1;
    return window.bytes <= byteLimit && window.frames <= MAX_FRAMES_PER_WINDOW;
  }
}

export function createStandaloneServer(options: StandaloneOptions = {}): { server: Server; close: () => Promise<void>; config: RuntimeConfig } {
  const config = runtimeConfig(options);
  const store = new SessionStore(config.stateFile);
  const createLimiter = new FixedWindowLimiter(10, 60_000);
  const connectLimiter = new FixedWindowLimiter(120, 60_000);
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_SNAPSHOT + 64 });
  const server = createServer((request, response) => void route(request, response, config, store, createLimiter));

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", config.publicUrl);
      const match = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{32})\/ws$/);
      if (!match) return rejectUpgrade(socket, 404, "Not Found");
      if (!connectLimiter.allow(clientIP(request, config.trustProxy))) return rejectUpgrade(socket, 429, "Too Many Requests");
      const relay = store.sessions.get(match[1]);
      if (!relay) return rejectUpgrade(socket, 404, "Session not found");
      if (relay.meta.expiresAt <= Date.now() && !relay.hasHost()) {
        relay.expire();
        return rejectUpgrade(socket, 410, "Session expired");
      }
      const origin = request.headers.origin;
      if (origin && safeOrigin(origin) !== config.publicUrl.origin) return rejectUpgrade(socket, 403, "Origin not allowed");
      const authorization = request.headers.authorization;
      let role: Role = "viewer";
      if (authorization !== undefined) {
        if (!authorization.startsWith("Bearer ") || !secureEqual(sha256(authorization.slice(7)), relay.meta.hostTokenHash)) {
          return rejectUpgrade(socket, 401, "Invalid host token");
        }
        role = "host";
      }
      const admission = viewerAdmission(relay.viewers.size);
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        if (role === "viewer" && !admission.accepted) return close(websocket, admission.closeCode, admission.reason);
        relay.accept(websocket, request, role);
      });
    })().catch(() => rejectUpgrade(socket, 500, "Internal Server Error"));
  });

  const sweep = setInterval(() => store.sweep(), 30_000);
  sweep.unref();
  return {
    server,
    config,
    close: async () => {
      clearInterval(sweep);
      const sockets = new Set<WebSocket>();
      for (const relay of store.sessions.values()) {
        if (relay.host) sockets.add(relay.host);
        for (const viewer of relay.viewers.keys()) sockets.add(viewer);
      }
      for (const socket of sockets) close(socket, 1001, "server shutting down");
      if (sockets.size > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

async function route(request: IncomingMessage, response: ServerResponse, config: RuntimeConfig, store: SessionStore, createLimiter: FixedWindowLimiter): Promise<void> {
  const url = new URL(request.url ?? "/", config.publicUrl);
  if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true, service: "shell.online-standalone" });
  if (url.pathname === "/api/sessions" && request.method === "POST") {
    if (!createLimiter.allow(clientIP(request, config.trustProxy))) return json(response, 429, { error: "too many sessions created" }, { "Retry-After": "60" });
    let body: Record<string, unknown>;
    try { body = await readJSON(request, MAX_BODY); }
    catch (error) { return json(response, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "request too large" : "invalid request" }); }
    if (typeof body.encrypted !== "boolean") return json(response, 400, { error: "encrypted must be a boolean" });
    if (body.read_only !== undefined && typeof body.read_only !== "boolean") return json(response, 400, { error: "read_only must be a boolean" });
    if (body.persistent !== undefined && typeof body.persistent !== "boolean") return json(response, 400, { error: "persistent must be a boolean" });
    if (body.persistent === true) return json(response, 400, { error: "persistent sessions require saved client credentials" });
    const id = token(24);
    const hostToken = token(32);
    const now = Date.now();
    const relay = store.add({
      id, hostTokenHash: sha256(hostToken), readOnly: body.read_only === true,
      encrypted: body.encrypted, persistent: false, label: sanitizeLabel(body.label),
      createdAt: now, expiresAt: now + SESSION_TTL_MS, status: "waiting",
    });
    return sessionResponse(response, config.publicUrl, relay.meta, hostToken);
  }
  if (url.pathname === "/api/sessions/resume" && request.method === "POST") {
    if (!createLimiter.allow(clientIP(request, config.trustProxy))) return json(response, 429, { error: "too many sessions resumed" }, { "Retry-After": "60" });
    let body: Record<string, unknown>;
    try { body = await readJSON(request, MAX_BODY); } catch { return json(response, 400, { error: "invalid session" }); }
    if (typeof body.session_id !== "string" || !SESSION_ID.test(body.session_id) || typeof body.host_token !== "string" ||
      typeof body.read_only !== "boolean" || typeof body.encrypted !== "boolean") return json(response, 400, { error: "invalid persistent session" });
    if (!secureEqual(await persistentSessionID(body.host_token), body.session_id)) return json(response, 403, { error: "persistent credentials rejected" });
    let relay = store.sessions.get(body.session_id);
    const hostTokenHash = sha256(body.host_token);
    if (relay && (!secureEqual(relay.meta.hostTokenHash, hostTokenHash) || !relay.meta.persistent || relay.meta.readOnly !== body.read_only || relay.meta.encrypted !== body.encrypted)) {
      return json(response, 403, { error: "persistent credentials rejected" });
    }
    const now = Date.now();
    if (!relay) {
      relay = store.add({ id: body.session_id, hostTokenHash, readOnly: body.read_only, encrypted: body.encrypted,
        persistent: true, label: sanitizeLabel(body.label), createdAt: now, expiresAt: now + PERSISTENT_TTL_MS, status: "waiting" });
    } else {
      relay.meta.label = sanitizeLabel(body.label);
      relay.meta.expiresAt = now + PERSISTENT_TTL_MS;
      if (relay.meta.status === "exited") relay.meta.status = "waiting";
      relay.persist();
    }
    return sessionResponse(response, config.publicUrl, relay.meta, body.host_token);
  }
  const status = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{32})$/);
  if (status && request.method === "GET") {
    const relay = store.sessions.get(status[1]);
    if (!relay || (relay.meta.expiresAt <= Date.now() && !relay.hasHost())) return json(response, 404, { exists: false });
    return json(response, 200, { exists: true, status: relay.meta.status, read_only: relay.meta.readOnly, encrypted: relay.meta.encrypted });
  }
  if (url.pathname === "/api/events" && request.method === "POST") return noContent(response);
  if (url.pathname === "/api/github" && request.method === "GET") return proxyJSON(response, "https://api.github.com/repos/TeoSlayer/shell.online", { stars: null, url: "https://github.com/TeoSlayer/shell.online" }, (value) => ({ stars: typeof value.stargazers_count === "number" ? value.stargazers_count : null, url: value.html_url }));
  if (url.pathname === "/api/docs/releases" && request.method === "GET") return proxyJSON(response, "https://api.github.com/repos/TeoSlayer/shell.online/releases?per_page=50", { releases: [] }, (value) => ({ releases: Array.isArray(value) ? value.flatMap((release) => typeof release?.tag_name === "string" && /^v\d+\.\d+\.\d+$/.test(release.tag_name) ? [{ version: release.tag_name.slice(1), publishedAt: release.published_at ?? null }] : []) : [] }));
  if (url.pathname === "/api/docs/content" && request.method === "GET") {
    const version = url.searchParams.get("version");
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return json(response, 404, { error: "documentation version not found" });
    return proxyRaw(response, `https://raw.githubusercontent.com/TeoSlayer/shell.online/v${version}/docs/content.json`);
  }
  if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "not found" });
  serveAsset(request, response, config.webRoot, url.pathname);
}

function runtimeConfig(options: StandaloneOptions): RuntimeConfig {
  const publicUrl = new URL(options.publicUrl ?? process.env.SHELL_ONLINE_PUBLIC_URL ?? "http://localhost:8080");
  if (!/^https?:$/.test(publicUrl.protocol) || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("SHELL_ONLINE_PUBLIC_URL must be an http(s) origin without a path");
  return {
    host: options.host ?? process.env.HOST ?? "0.0.0.0",
    port: options.port ?? Number(process.env.PORT ?? "8080"),
    publicUrl,
    webRoot: resolve(options.webRoot ?? process.env.SHELL_ONLINE_WEB_ROOT ?? "dist"),
    stateFile: resolve(options.stateFile ?? process.env.SHELL_ONLINE_STATE_FILE ?? "data/relay.json"),
    trustProxy: options.trustProxy ?? process.env.SHELL_ONLINE_TRUST_PROXY === "1",
  };
}

function sessionResponse(response: ServerResponse, origin: URL, meta: SessionMeta, hostToken: string): void {
  const websocket = new URL(`/api/sessions/${meta.id}/ws`, origin);
  websocket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  json(response, 201, { session_id: meta.id, share_url: new URL(`/s/${meta.id}`, origin).href, websocket_url: websocket.href,
    host_token: hostToken, read_only: meta.readOnly, encrypted: meta.encrypted, persistent: meta.persistent,
    expires_at: new Date(meta.expiresAt).toISOString() });
}

function serveAsset(request: IncomingMessage, response: ServerResponse, root: string, pathname: string): void {
  if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return json(response, 400, { error: "invalid path" }); }
  const special = decoded.startsWith("/docs/v") ? "/docs/" : decoded;
  const relative = special === "/" || special.startsWith("/s/") || special.endsWith("/") ? `${special.replace(/^\//, "")}index.html` : special.replace(/^\//, "");
  let candidate = resolve(root, normalize(relative));
  if (!candidate.startsWith(`${root}/`) && candidate !== root) return json(response, 404, { error: "not found" });
  if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = join(root, "index.html");
  if (!existsSync(candidate)) return json(response, 503, { error: "web assets are not built" });
  const headers = securityHeaders();
  headers["Content-Type"] = contentType(candidate);
  headers["Content-Length"] = String(statSync(candidate).size);
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(candidate).pipe(response);
}

function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Cross-Origin-Opener-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  };
}

function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const value = JSON.stringify(body);
  response.writeHead(status, { ...securityHeaders(), ...extra, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(value)) });
  response.end(value);
}

function noContent(response: ServerResponse): void { response.writeHead(204, securityHeaders()); response.end(); }

async function proxyJSON(response: ServerResponse, url: string, fallback: unknown, project: (value: any) => unknown): Promise<void> {
  try {
    const upstream = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "shell.online-standalone" }, signal: AbortSignal.timeout(5_000) });
    if (!upstream.ok) throw new Error("upstream failure");
    json(response, 200, project(await upstream.json()));
  } catch { json(response, 200, fallback); }
}

async function proxyRaw(response: ServerResponse, url: string): Promise<void> {
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!upstream.ok) return json(response, 404, { error: "documentation version not found" });
    const body = await upstream.text();
    if (body.length > 128 * 1024) return json(response, 502, { error: "documentation is too large" });
    response.writeHead(200, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8" }); response.end(body);
  } catch { json(response, 502, { error: "documentation version unavailable" }); }
}

async function readJSON(request: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > maximum) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid JSON object");
  return value as Record<string, unknown>;
}

class BodyTooLarge extends Error {}

function token(bytes: number): string { return randomBytes(bytes).toString("base64url"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sanitizeLabel(value: unknown): string {
  if (typeof value !== "string") return "terminal";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "terminal";
}
function validMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<SessionMeta>;
  return typeof meta.id === "string" && SESSION_ID.test(meta.id) && typeof meta.hostTokenHash === "string" && /^[a-f0-9]{64}$/.test(meta.hostTokenHash) &&
    typeof meta.readOnly === "boolean" && typeof meta.encrypted === "boolean" && typeof meta.persistent === "boolean" && typeof meta.label === "string" &&
    typeof meta.createdAt === "number" && typeof meta.expiresAt === "number" && ["waiting", "connected", "disconnected", "exited"].includes(meta.status ?? "");
}
function rawData(value: RawData): Buffer { return Array.isArray(value) ? Buffer.concat(value) : Buffer.from(value as ArrayBuffer); }
function send(socket: WebSocket, value: Buffer | string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return close(socket, 4008, "slow connection");
  socket.send(value, { binary: typeof value !== "string" });
}
function sendJSON(socket: WebSocket, value: unknown): void { send(socket, JSON.stringify(value)); }
function close(socket: WebSocket, code: number, reason: string): void { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason); }
function safeOrigin(value: string): string { try { return new URL(value).origin; } catch { return ""; } }
function mobileUserAgent(value: string | undefined): boolean { return /Android|iPhone|iPad|iPod|Mobile/i.test(value ?? ""); }
function clientIP(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) return String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  return request.socket.remoteAddress || "unknown";
}
function rejectUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function contentType(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createStandaloneServer();
  runtime.server.listen(runtime.config.port, runtime.config.host, () => {
    process.stdout.write(`shell.online standalone relay listening on ${runtime.config.host}:${runtime.config.port} (${runtime.config.publicUrl.origin})\n`);
  });
  const shutdown = () => void runtime.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
