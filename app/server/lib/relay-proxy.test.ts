import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { relayProxy } from "./relay-proxy";

/**
 * The relay double behaves the way the real one does in the ways that matter:
 * it refuses a websocket whose Origin is not its own, and it answers a good
 * one with a real 101 handshake. Everything here is checked against that
 * rather than against an assertion about what the proxy sent.
 */
let relay: Server;
let relayOrigin: string;
let seenOrigins: string[] = [];

let proxy: Server;
let proxyPort = 0;

function accept(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-5AB0DC85B11F`)
    .digest("base64");
}

beforeAll(async () => {
  relay = createServer((request, response) => {
    seenOrigins.push(String(request.headers.origin ?? ""));
    if (request.url === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ relay: true, origin: request.headers.origin }));
      return;
    }
    response.writeHead(404);
    response.end("no");
  });

  relay.on("upgrade", (request, socket: Socket, head) => {
    seenOrigins.push(String(request.headers.origin ?? ""));
    if (request.headers.origin !== relayOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.end();
      return;
    }
    if (request.url === "/api/sessions/gone/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.end();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept(String(request.headers["sec-websocket-key"]))}`,
        "",
        "",
      ].join("\r\n"),
    );
    /* Echo, so the test can prove bytes travel both ways after the handshake. */
    if (head?.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });

  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayAddress = relay.address();
  const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
  relayOrigin = `http://127.0.0.1:${relayPort}`;

  const forward = relayProxy(relayOrigin);
  proxy = createServer((request, response) => {
    if (forward.handles(request.url)) return forward.request(request, response);
    response.writeHead(404);
    response.end("not the proxy's");
  });
  proxy.on("upgrade", (request, socket, head) => {
    if (forward.handles(request.url)) return forward.upgrade(request, socket, head);
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  proxyPort = typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0;
});

afterAll(() => {
  relay.close();
  proxy.close();
});

/** Opens a raw websocket handshake through the proxy and reports what came back. */
function handshake(path: string, origin: string): Promise<{ head: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${proxyPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) {
        const [head] = buffer.split("\r\n\r\n");
        resolve({ head, socket });
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("handshake timed out")), 5000);
  });
}

describe("relayProxy", () => {
  it("claims only its own prefix", () => {
    const forward = relayProxy("http://example.invalid");
    expect(forward.handles("/relay/api/sessions/x/ws")).toBe(true);
    expect(forward.handles("/api/sessions")).toBe(false);
    expect(forward.handles("/relayed/thing")).toBe(false);
    expect(forward.handles(undefined)).toBe(false);
  });

  it("forwards an ordinary request with the relay's own origin", async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/relay/api/health`, {
      headers: { origin: "https://app.example.com" },
    });
    expect(response.status).toBe(200);
    /* The relay saw its own origin, not the browser's. */
    expect(((await response.json()) as { origin: string }).origin).toBe(relayOrigin);
  });

  /*
   * The whole reason this proxy exists: a browser on another hostname cannot
   * open a relay websocket, and the relay is right to refuse it.
   */
  it("completes a websocket handshake a browser could not have made directly", async () => {
    const { head, socket } = await handshake("/relay/api/sessions/abc/ws", "https://app.example.com");
    expect(head).toContain("101");
    expect(head.toLowerCase()).toContain("sec-websocket-accept:");
    socket.destroy();
  });

  it("keeps the relay's accept key rather than inventing one", async () => {
    const { head, socket } = await handshake("/relay/api/sessions/abc/ws", "https://app.example.com");
    /*
     * sha1(the key this test sent + the RFC 6455 GUID), base64. A proxy that
     * opened its own socket with its own key would answer with a value the
     * browser's websocket then rejects.
     */
    expect(head).toContain("tF+4yo8PvjWV9zMFht911yVrKKY=");
    socket.destroy();
  });

  it("carries bytes in both directions once upgraded", async () => {
    const { socket } = await handshake("/relay/api/sessions/abc/ws", "https://app.example.com");
    const echoed = await new Promise<string>((resolve) => {
      socket.on("data", (chunk) => resolve(chunk.toString()));
      socket.write("frame");
    });
    expect(echoed).toBe("frame");
    socket.destroy();
  });

  /*
   * A refusal is information: 404 means the session is gone, and telling the
   * browser 502 instead would send someone looking for a network fault.
   */
  it("passes a relay's refusal through with its status", async () => {
    const { head, socket } = await handshake("/relay/api/sessions/gone/ws", "https://app.example.com");
    expect(head).toContain("404");
    socket.destroy();
  });

  it("answers 502 rather than hanging when the relay is unreachable", async () => {
    const dead = relayProxy("http://127.0.0.1:1");
    const server = createServer((request, response) => dead.request(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/relay/api/health`);
    expect(response.status).toBe(502);
    server.close();
  });

  it("does not pass the browser's origin along", async () => {
    seenOrigins = [];
    await fetch(`http://127.0.0.1:${proxyPort}/relay/api/health`, {
      headers: { origin: "https://app.example.com" },
    });
    expect(seenOrigins).toEqual([relayOrigin]);
  });
});
