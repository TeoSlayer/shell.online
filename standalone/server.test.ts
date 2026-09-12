import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type ClientOptions } from "ws";

import { Opcode } from "../shared/protocol";
import { persistentSessionID } from "../shared/persistent-session";
import { createStandaloneServer } from "./server";

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
  return { runtime, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, stateFile: stateFile ?? join(root, "state.json") };
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
