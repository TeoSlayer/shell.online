import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type ClientOptions } from "ws";

import { Opcode } from "../shared/protocol";
import { persistentSessionID } from "../shared/persistent-session";
import { createStandaloneServer } from "./server";
import { RELEASE_VERSION } from "../shared/release";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function start(stateFile?: string) {
  const root = mkdtempSync(join(tmpdir(), "shell-online-standalone-"));
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", "index.html"), "<!doctype html><title>standalone</title>");
  const runtime = createStandaloneServer({ port: 0, publicUrl: "http://127.0.0.1", webRoot: join(root, "web"), stateFile: stateFile ?? join(root, "state.json") });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const port = (runtime.server.address() as AddressInfo).port;
  cleanup.push(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, webRoot: join(root, "web"), base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, stateFile: stateFile ?? join(root, "state.json") };
}

async function create(base: string, readOnly = false, encrypted = false) {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "test", read_only: readOnly, encrypted }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { session_id: string; host_token: string };
}

function open(url: string, options?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function message(socket: WebSocket, predicate: (value: string | Buffer) => boolean): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", listener); reject(new Error("message timeout")); }, 2_000);
    const listener = (value: Buffer, binary: boolean) => {
      const parsed = binary ? value : value.toString();
      if (!predicate(parsed)) return;
      clearTimeout(timeout); socket.off("message", listener); resolve(parsed);
    };
    socket.on("message", listener);
  });
}

describe("standalone relay", () => {
  test("serves current and archived documentation through the same version-aware mapping", async () => {
    const { base, webRoot } = await start();
    mkdirSync(join(webRoot, "docs"));
    mkdirSync(join(webRoot, "docs", "archive"));
    mkdirSync(join(webRoot, "mobile"));
    writeFileSync(join(webRoot, "docs", "archive", "index.html"), "archived guide loading");
    writeFileSync(join(webRoot, "mobile", "index.html"), "current mobile guide");
    expect(await (await fetch(`${base}/docs/v0.6.0/mobile/`)).text()).toBe("archived guide loading");
    expect(await (await fetch(`${base}/docs/v${RELEASE_VERSION}/mobile/`)).text()).toBe("current mobile guide");
  });
  test("serves the app and health endpoint", async () => {
    const { base } = await start();
    expect(await (await fetch(base)).text()).toContain("standalone");
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true, service: "shell.online-standalone" });
  });

  test("authenticates the host and relays opaque terminal frames", async () => {
    const { base, ws } = await start();
    const session = await create(base);
    const host = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Authorization: `Bearer ${session.host_token}`, "X-Shell-Terminal-Grid": "80x40" } });
    const viewer = await open(`${ws}/api/sessions/${session.session_id}/ws?layout=portrait`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.terminate(); viewer.terminate(); });

    const output = Buffer.from([Opcode.Output, 0xde, 0xad, 0xbe, 0xef]);
    const received = message(viewer, (value) => Buffer.isBuffer(value) && value[0] === Opcode.Output);
    host.send(output);
    expect(await received).toEqual(output);

    const input = Buffer.from([Opcode.Input, 0x61]);
    const returned = message(host, (value) => Buffer.isBuffer(value) && value[0] === Opcode.Input);
    viewer.send(input);
    expect(await returned).toEqual(input);
  });

  test("enforces read-only access in the relay", async () => {
    const { base, ws } = await start();
    const session = await create(base, true);
    const viewer = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => viewer.terminate());
    const denied = message(viewer, (value) => typeof value === "string" && value.includes("access_denied"));
    viewer.send(Buffer.from([Opcode.Input, 0x61]));
    expect(JSON.parse(await denied as string)).toEqual({ type: "access_denied", reason: "read_only" });
  });

  test("targets opted-in file requests and responses to one viewer", async () => {
    const { base, ws } = await start();
    const session = await create(base, true);
    const host = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Authorization: `Bearer ${session.host_token}` } });
    const viewer = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Origin: "http://127.0.0.1" } });
    const other = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.terminate(); viewer.terminate(); other.terminate(); });

    const request = message(host, (value) => Buffer.isBuffer(value) && value[0] === Opcode.FileRequest);
    viewer.send(Buffer.from([Opcode.FileRequest, 0xaa, 0xbb]));
    const targeted = await request as Buffer;
    expect(targeted.subarray(5)).toEqual(Buffer.from([0xaa, 0xbb]));

    let leaked = false;
    other.on("message", (value: Buffer) => { if (value[0] === Opcode.FileResponse) leaked = true; });
    const response = message(viewer, (value) => Buffer.isBuffer(value) && value[0] === Opcode.FileResponse);
    host.send(Buffer.concat([Buffer.from([Opcode.FileResponse]), targeted.subarray(1, 5), Buffer.from([0xcc])]));
    expect(await response).toEqual(Buffer.from([Opcode.FileResponse, 0xcc]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(leaked).toBe(false);
  });

  test("routes E2EE envelopes byte-for-byte and rejects a false host token", async () => {
    const { base, ws } = await start();
    const session = await create(base, false, true);
    const rejected = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Authorization: "Bearer false-token" } });
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    });
    expect(rejected).toBe(401);

    const host = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Authorization: `Bearer ${session.host_token}` } });
    const viewer = await open(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.terminate(); viewer.terminate(); });
    const envelope = Buffer.concat([Buffer.from([Opcode.Output, 1]), Buffer.alloc(28, 0xa5)]);
    const received = message(viewer, (value) => Buffer.isBuffer(value) && value[0] === Opcode.Output);
    host.send(envelope);
    expect(await received).toEqual(envelope);
  });

  test("persists only hashed credentials and resumes an identity after restart", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "shell-online-state-"));
    const stateFile = join(stateRoot, "relay.json");
    cleanup.push(() => rmSync(stateRoot, { recursive: true, force: true }));
    const first = await start(stateFile);
    const hostToken = "a".repeat(43);
    const id = await persistentSessionID(hostToken);
    const response = await fetch(`${first.base}/api/sessions/resume`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id, host_token: hostToken, label: "persistent", read_only: false, encrypted: true }),
    });
    expect(response.status).toBe(201);
    const onDisk = readText(stateFile);
    expect(onDisk).not.toContain(hostToken);
    await cleanup.pop()?.();

    const second = await start(stateFile);
    const status = await fetch(`${second.base}/api/sessions/${id}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ exists: true, status: "disconnected", encrypted: true });
  });

  test("rejects browser websocket connections from another origin", async () => {
    const { base, ws } = await start();
    const session = await create(base);
    const error = await new Promise<Error>((resolve) => {
      const socket = new WebSocket(`${ws}/api/sessions/${session.session_id}/ws`, { headers: { Origin: "https://attacker.example" } });
      socket.once("unexpected-response", (_request, response) => resolve(new Error(String(response.statusCode))));
      socket.once("error", resolve);
    });
    expect(error.message).toContain("403");
  });
});

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/* Records every message from the moment the socket opens, so order can be asserted. */
function openRecording(url: string, options?: ClientOptions): Promise<{ socket: WebSocket; received: Array<string | Buffer> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const received: Array<string | Buffer> = [];
    socket.on("message", (value: Buffer, binary: boolean) => received.push(binary ? value : value.toString()));
    socket.once("open", () => resolve({ socket, received }));
    socket.once("error", reject);
  });
}

function sizes(received: Array<string | Buffer>): Array<Record<string, unknown>> {
  return received
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .filter((value) => value.type === "terminal_size");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

describe("standalone relay with a host that owns its grid", () => {
  test("passes the host's grid on once per change and never resizes for a viewer", async () => {
    const { base, ws } = await start();
    const session = await create(base);
    const url = `${ws}/api/sessions/${session.session_id}/ws`;
    const host = await openRecording(url, { headers: { Authorization: `Bearer ${session.host_token}`, "X-Shell-Terminal-Grid": "dynamic" } });
    host.socket.send(JSON.stringify({ type: "terminal_grid", cols: 173, rows: 51 }));
    await settle();
    const desk = await openRecording(url, { headers: { Origin: "http://127.0.0.1" } });
    const phone = await openRecording(`${url}?layout=portrait`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.socket.terminate(); desk.socket.terminate(); phone.socket.terminate(); });
    await settle();
    phone.socket.send(JSON.stringify({ type: "viewer_layout", portrait: false }));
    host.socket.send(JSON.stringify({ type: "terminal_grid", cols: 173, rows: 51 }));
    await settle();
    phone.socket.close();
    await settle();

    expect(sizes(desk.received)).toEqual([{ type: "terminal_size", cols: 173, rows: 51, dynamic: true }]);
    expect(sizes(host.received)).toEqual([]);

    host.socket.send(JSON.stringify({ type: "terminal_grid", cols: 3, rows: 51 }));
    host.socket.send(JSON.stringify({ type: "terminal_grid", cols: 90, rows: 30 }));
    await settle();
    expect(sizes(desk.received).at(-1)).toEqual({ type: "terminal_size", cols: 90, rows: 30, dynamic: true });
    expect(sizes(desk.received)).toHaveLength(2);
  });

  test("tells a joining viewer the grid before its screen", async () => {
    const { base, ws } = await start();
    const session = await create(base);
    const url = `${ws}/api/sessions/${session.session_id}/ws`;
    const host = await openRecording(url, { headers: { Authorization: `Bearer ${session.host_token}`, "X-Shell-Terminal-Grid": "dynamic" } });
    host.socket.send(JSON.stringify({ type: "terminal_grid", cols: 140, rows: 40 }));
    await settle();
    const requested = message(host.socket, (value) => typeof value === "string" && value.includes("snapshot_request"));
    const viewer = await openRecording(url, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.socket.terminate(); viewer.socket.terminate(); });
    const { viewerId } = JSON.parse(await requested as string) as { viewerId: number };
    const header = Buffer.alloc(5);
    header[0] = Opcode.Snapshot;
    header.writeUInt32BE(viewerId, 1);
    host.socket.send(Buffer.concat([header, Buffer.from("screen")]));
    await settle();

    const sizeAt = viewer.received.findIndex((value) => typeof value === "string" && value.includes("terminal_size"));
    const screenAt = viewer.received.findIndex((value) => Buffer.isBuffer(value) && value[0] === Opcode.Snapshot);
    expect(sizeAt).toBeGreaterThanOrEqual(0);
    expect(screenAt).toBeGreaterThan(sizeAt);
    expect(JSON.parse(viewer.received[sizeAt] as string)).toEqual({ type: "terminal_size", cols: 140, rows: 40, dynamic: true });
  });

  test("forwards grid requests only from writers to a dynamic host", async () => {
    const { base, ws } = await start();
    const writable = await create(base);
    const url = `${ws}/api/sessions/${writable.session_id}/ws`;
    const host = await openRecording(url, { headers: { Authorization: `Bearer ${writable.host_token}`, "X-Shell-Terminal-Grid": "dynamic" } });
    const viewer = await openRecording(url, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { host.socket.terminate(); viewer.socket.terminate(); });
    await settle();
    const welcome = viewer.received.map((value) => JSON.parse(value as string)).find((value) => value.type === "welcome");
    viewer.socket.send(JSON.stringify({ type: "grid_request", cols: 48, rows: 30 }));
    viewer.socket.send(JSON.stringify({ type: "grid_request", cols: 48, rows: 30 }));
    viewer.socket.send(JSON.stringify({ type: "grid_request", cols: 48, rows: 400 }));
    await settle();
    const forwarded = host.received
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "grid_request");
    expect(forwarded).toEqual([{ type: "grid_request", cols: 48, rows: 30, viewerId: welcome.viewerId }]);
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);

    const readOnly = await create(base, true);
    const roUrl = `${ws}/api/sessions/${readOnly.session_id}/ws`;
    const roHost = await openRecording(roUrl, { headers: { Authorization: `Bearer ${readOnly.host_token}`, "X-Shell-Terminal-Grid": "dynamic" } });
    const roViewer = await openRecording(roUrl, { headers: { Origin: "http://127.0.0.1" } });
    const legacy = await create(base);
    const legacyUrl = `${ws}/api/sessions/${legacy.session_id}/ws`;
    const legacyHost = await openRecording(legacyUrl, { headers: { Authorization: `Bearer ${legacy.host_token}`, "X-Shell-Terminal-Grid": "80x40" } });
    const legacyViewer = await openRecording(`${legacyUrl}?layout=portrait`, { headers: { Origin: "http://127.0.0.1" } });
    cleanup.push(() => { roHost.socket.terminate(); roViewer.socket.terminate(); legacyHost.socket.terminate(); legacyViewer.socket.terminate(); });
    await settle();
    roViewer.socket.send(JSON.stringify({ type: "grid_request", cols: 48, rows: 30 }));
    legacyViewer.socket.send(JSON.stringify({ type: "grid_request", cols: 48, rows: 30 }));
    await settle();
    expect(roHost.received.some((value) => typeof value === "string" && value.includes("grid_request"))).toBe(false);
    expect(legacyHost.received.some((value) => typeof value === "string" && value.includes("grid_request"))).toBe(false);
    /* The legacy session keeps its device-picked grid, host included. */
    expect(sizes(legacyHost.received).at(-1)).toEqual({ type: "terminal_size", cols: 80, rows: 40 });
  });
});
