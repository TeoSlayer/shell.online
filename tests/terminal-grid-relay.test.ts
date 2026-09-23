import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Opcode } from "../shared/protocol";

/*
 * The relay's side of a host that owns its grid. The Durable Object is driven
 * directly with mock sockets: every socket it accepts is recorded, so a test
 * can read exactly what each side was sent and in what order.
 */
vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    state: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.state = state;
      this.env = env;
    }
  },
}));

import { TerminalSession } from "../worker/index";

type Sent = { kind: "json"; value: Record<string, unknown> } | { kind: "binary"; value: Uint8Array };

class MockSocket {
  readyState = 1;
  sent: Sent[] = [];
  closedWith: number | undefined;
  private attachment: unknown;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(value: string | ArrayBuffer | Uint8Array) {
    if (typeof value === "string") this.sent.push({ kind: "json", value: JSON.parse(value) });
    else this.sent.push({ kind: "binary", value: new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)) });
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  json(type: string) {
    return this.sent.filter((item): item is Extract<Sent, { kind: "json" }> => item.kind === "json" && item.value.type === type).map((item) => item.value);
  }
}

const HOST_TOKEN = "host-token-grid";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeRoom() {
  const store = new Map<string, unknown>();
  const sockets: Array<{ socket: MockSocket; tags: string[] }> = [];
  const state = {
    id: { name: "GRID", toString: () => "GRID" },
    storage: {
      get: async (key: string | string[]) => {
        if (Array.isArray(key)) return new Map(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        return store.get(key);
      },
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") store.set(key, value);
        else for (const [k, v] of Object.entries(key)) store.set(k, v);
      },
      delete: async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
      },
      deleteAll: async () => store.clear(),
      setAlarm: async () => {},
      getAlarm: async () => null,
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    getWebSockets: (tag?: string) =>
      sockets.filter((entry) => tag === undefined || entry.tags.includes(tag)).map((entry) => entry.socket),
    waitUntil: () => {},
    acceptWebSocket: (socket: MockSocket, tags: string[]) => sockets.push({ socket, tags }),
  };
  const limiter = { limit: async () => ({ success: true }) };
  const stub = { fetch: async () => new Response("ok", { status: 200 }) };
  const env = {
    SESSIONS: { idFromName: (n: string) => n, get: () => stub },
    STATS: { idFromName: (n: string) => n, get: () => stub },
    SESSION_CREATION_LIMITER: limiter,
    CONNECTION_LIMITER: limiter,
    EVENT_LIMITER: limiter,
    ANALYTICS: { writeDataPoint: async () => {} },
  };
  const room = new TerminalSession(state as never, env as never);
  return { room, store, sockets };
}

/* Workers answer an upgrade with status 101, which Node's Response refuses; everything before it has run. */
async function accept(room: TerminalSession, request: Request): Promise<MockSocket> {
  const before = (globalThis as { __lastServer?: MockSocket }).__lastServer;
  try {
    await (room as unknown as { acceptSocket(request: Request): Promise<Response> }).acceptSocket(request);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const server = (globalThis as { __lastServer?: MockSocket }).__lastServer;
  if (!server || server === before) throw new Error("socket was not accepted");
  return server;
}

function hostRequest(grid?: string): Request {
  const headers: Record<string, string> = { Upgrade: "websocket", Authorization: `Bearer ${HOST_TOKEN}` };
  if (grid) headers["X-Shell-Terminal-Grid"] = grid;
  return new Request("https://shell.online/api/sessions/x/ws", { headers });
}

function viewerRequest(layout?: "portrait" | "landscape"): Request {
  const url = new URL("https://shell.online/api/sessions/x/ws");
  if (layout) url.searchParams.set("layout", layout);
  return new Request(url, { headers: { Upgrade: "websocket" } });
}

async function initialize(room: TerminalSession, readOnly = false) {
  const now = Date.now();
  const response = await room.fetch(
    new Request("https://shell.online/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostTokenHash: await sha256Hex(HOST_TOKEN),
        readOnly,
        encrypted: false,
        persistent: false,
        control: false,
        label: "grid",
        createdAt: now,
        expiresAt: now + 3_600_000,
      }),
    }),
  );
  expect(response.ok).toBe(true);
}

async function say(room: TerminalSession, socket: MockSocket, value: unknown) {
  await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(value));
}

function snapshotFor(viewerId: number, body: number[]): ArrayBuffer {
  const frame = new Uint8Array(5 + body.length);
  frame[0] = Opcode.Snapshot;
  new DataView(frame.buffer).setUint32(1, viewerId);
  frame.set(body, 5);
  return frame.buffer;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).WebSocketPair = class {
    0: MockSocket;
    1: MockSocket;
    constructor() {
      this[0] = new MockSocket();
      this[1] = new MockSocket();
      (globalThis as { __lastServer?: MockSocket }).__lastServer = this[1];
    }
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).WebSocketPair;
  delete (globalThis as Record<string, unknown>).__lastServer;
});

describe("a host that owns its grid", () => {
  it("passes the host's grid to viewers once per change and never sends one to the host", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    const viewer = await accept(room, viewerRequest("portrait"));
    await say(room, host, { type: "terminal_grid", cols: 173, rows: 51 });
    expect(viewer.json("terminal_size")).toEqual([{ type: "terminal_size", cols: 173, rows: 51, dynamic: true, credentialRotation: true }]);

    await say(room, host, { type: "terminal_grid", cols: 173, rows: 51 });
    expect(viewer.json("terminal_size")).toHaveLength(1);

    await say(room, host, { type: "terminal_grid", cols: 90, rows: 30 });
    expect(viewer.json("terminal_size").at(-1)).toMatchObject({ cols: 90, rows: 30 });
    expect(host.json("terminal_size")).toEqual([]);
  });

  /*
   * A legacy host learns that live password rotation is supported from the
   * terminal_size it is sent. A dynamic host is never sent one, so without
   * this it would silently lose rotation.
   */
  it("tells a dynamic host the relay supports credential rotation", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    expect(host.json("relay_features")).toEqual([{ type: "relay_features", terminalGrid: true, credentialRotation: true }]);
    const legacy = await accept(room, hostRequest("80x40"));
    expect(legacy.json("relay_features")).toEqual([]);
  });

  /*
   * A host that owns its grid sends nothing about it until told the relay
   * understands one, so that word has to come before the relay asks it for a
   * snapshot: the grid then reaches every viewer ahead of the screen.
   */
  it("says it understands grids before asking a returning host for any snapshot", async () => {
    const { room } = makeRoom();
    await initialize(room);
    await accept(room, viewerRequest());
    const host = await accept(room, hostRequest("80x40,160x48,dynamic"));
    const order = host.sent
      .flatMap((item) => (item.kind === "json" ? [String(item.value.type)] : []))
      .filter((type) => type === "relay_features" || type === "snapshot_request");
    expect(order[0]).toBe("relay_features");
    expect(order).toContain("snapshot_request");
  });

  /* The header the CLI really sends: sizes for older relays, then "dynamic". */
  it("treats the CLI's full header as a host that owns its grid", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("80x40,160x48,dynamic"));
    const viewer = await accept(room, viewerRequest("portrait"));
    await say(room, host, { type: "terminal_grid", cols: 97, rows: 31 });
    expect(viewer.json("terminal_size")).toEqual([{ type: "terminal_size", cols: 97, rows: 31, dynamic: true, credentialRotation: true }]);
    expect(host.json("terminal_size")).toEqual([]);
    expect(host.json("relay_features")).toEqual([{ type: "relay_features", terminalGrid: true, credentialRotation: true }]);
  });

  it("ignores a grid out of range", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    const viewer = await accept(room, viewerRequest());
    await say(room, host, { type: "terminal_grid", cols: 5, rows: 51 });
    await say(room, host, { type: "terminal_grid", cols: 120.5, rows: 30 });
    await say(room, host, { type: "terminal_grid", cols: "120", rows: 30 });
    expect(viewer.json("terminal_size")).toEqual([]);
    expect(host.closedWith).toBeUndefined();
  });

  it("does not let viewers joining, rotating or leaving change the grid", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    await say(room, host, { type: "terminal_grid", cols: 200, rows: 60 });
    const desk = await accept(room, viewerRequest("landscape"));
    const phone = await accept(room, viewerRequest("portrait"));
    await say(room, phone, { type: "viewer_layout", portrait: false });
    await say(room, phone, { type: "viewer_layout", portrait: true });
    await room.webSocketClose(phone as unknown as WebSocket, 1000, "", true);

    expect(host.json("terminal_size")).toEqual([]);
    expect(desk.json("terminal_size")).toEqual([{ type: "terminal_size", cols: 200, rows: 60, dynamic: true, credentialRotation: true }]);
    expect(phone.json("terminal_size")).toEqual([{ type: "terminal_size", cols: 200, rows: 60, dynamic: true, credentialRotation: true }]);
  });

  it("tells a joining viewer the grid before any screen reaches it", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    await say(room, host, { type: "terminal_grid", cols: 140, rows: 40 });
    const viewer = await accept(room, viewerRequest());
    const request = host.json("snapshot_request").at(-1) as { viewerId: number };
    await room.webSocketMessage(host as unknown as WebSocket, snapshotFor(request.viewerId, [0x61]));

    const sizeAt = viewer.sent.findIndex((item) => item.kind === "json" && item.value.type === "terminal_size");
    const screenAt = viewer.sent.findIndex((item) => item.kind === "binary" && item.value[0] === Opcode.Snapshot);
    expect(sizeAt).toBeGreaterThanOrEqual(0);
    expect(screenAt).toBeGreaterThan(sizeAt);
    expect(viewer.sent[sizeAt]).toMatchObject({ value: { cols: 140, rows: 40 } });
  });

  it("replays the kept screen at the grid it was drawn at", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    await say(room, host, { type: "terminal_grid", cols: 150, rows: 45 });
    await accept(room, viewerRequest());
    const request = host.json("snapshot_request").at(-1) as { viewerId: number };
    await room.webSocketMessage(host as unknown as WebSocket, snapshotFor(request.viewerId, [0x62, 0x63]));
    /* The machine moves on to another size, then goes away. */
    await say(room, host, { type: "terminal_grid", cols: 100, rows: 30 });
    host.readyState = 3;
    await room.webSocketClose(host as unknown as WebSocket, 1006, "", false);

    const late = await accept(room, viewerRequest());
    const sizes = late.json("terminal_size");
    expect(sizes.at(-1)).toMatchObject({ cols: 150, rows: 45, dynamic: true });
    const lastSizeAt = late.sent.map((item) => item.kind === "json" && item.value.type === "terminal_size").lastIndexOf(true);
    const screenAt = late.sent.findIndex((item) => item.kind === "binary" && item.value[0] === Opcode.Snapshot);
    expect(screenAt).toBeGreaterThan(lastSizeAt);
    expect(Array.from((late.sent[screenAt] as { value: Uint8Array }).value.subarray(1))).toEqual([0x62, 0x63]);
  });
});

describe("grid requests", () => {
  it("forwards a writer's request to a dynamic host, dropping invalid ones and immediate repeats", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("dynamic"));
    const viewer = await accept(room, viewerRequest());
    const viewerId = (viewer.json("welcome")[0] as { viewerId: number }).viewerId;

    await say(room, viewer, { type: "grid_request", cols: 48, rows: 30 });
    await say(room, viewer, { type: "grid_request", cols: 48, rows: 30 });
    await say(room, viewer, { type: "grid_request", cols: 3, rows: 30 });
    await say(room, viewer, { type: "grid_request", cols: 48, rows: 999 });
    expect(host.json("grid_request")).toEqual([{ type: "grid_request", cols: 48, rows: 30, viewerId }]);

    await say(room, viewer, { type: "grid_request", cols: 60, rows: 30 });
    expect(host.json("grid_request").at(-1)).toMatchObject({ cols: 60, rows: 30 });
    expect(viewer.closedWith).toBeUndefined();
  });

  it("forwards nothing from a read-only session", async () => {
    const { room } = makeRoom();
    await initialize(room, true);
    const host = await accept(room, hostRequest("dynamic"));
    const viewer = await accept(room, viewerRequest());
    await say(room, viewer, { type: "grid_request", cols: 48, rows: 30 });
    expect(host.json("grid_request")).toEqual([]);
    expect(viewer.closedWith).toBeUndefined();
  });

  it("forwards nothing to a host that does not own its grid", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("80x40"));
    const viewer = await accept(room, viewerRequest());
    await say(room, viewer, { type: "grid_request", cols: 48, rows: 30 });
    expect(host.json("grid_request")).toEqual([]);
    expect(viewer.closedWith).toBeUndefined();
  });
});

describe("a legacy host", () => {
  it("is still given a grid picked from the devices watching", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest("80x40"));
    await accept(room, viewerRequest("portrait"));
    expect(host.json("terminal_size").at(-1)).toMatchObject({ cols: 80, rows: 40 });
    expect(host.json("terminal_size").every((message) => !("dynamic" in message))).toBe(true);
    /* A legacy host announcing a grid is not believed. */
    await say(room, host, { type: "terminal_grid", cols: 150, rows: 50 });
    expect(host.json("terminal_size").at(-1)).toMatchObject({ cols: 80, rows: 40 });
  });

  it("falls back to 80x24 for a portrait viewer when the host has no grid header", async () => {
    const { room } = makeRoom();
    await initialize(room);
    const host = await accept(room, hostRequest());
    await accept(room, viewerRequest("portrait"));
    expect(host.json("terminal_size").at(-1)).toMatchObject({ cols: 80, rows: 24 });
  });
});
