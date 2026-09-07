import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalConnection, type ConnectionStatus } from "./connection";
import { Opcode, encodeFrame } from "./protocol";
import { BrowserFrameCipher } from "./e2ee";

/* A WebSocket stand-in that lets a test drive both directions by hand. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static created = 0;

  binaryType = "";
  readyState = 0;
  sent: (ArrayBufferLike | string)[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(public readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.created += 1;
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  send(payload: ArrayBufferLike | string) {
    this.sent.push(payload);
  }

  close(code?: number) {
    this.readyState = 3;
    this.emit("close", { code: code ?? 1000 });
  }

  private emit(type: string, event: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /* ---- test drivers ---- */
  opened() {
    this.readyState = 1;
    this.emit("open", {});
  }

  binary(frame: Uint8Array) {
    this.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  control(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  closedWith(code: number) {
    this.readyState = 3;
    this.emit("close", { code });
  }
}

interface Recorded {
  statuses: { status: ConnectionStatus; detail?: string }[];
  writes: { text: string; reset: boolean }[];
  readOnly: boolean[];
}

function connect(fragment = "") {
  const recorded: Recorded = { statuses: [], writes: [], readOnly: [] };
  const connection = new TerminalConnection({
    url: "ws://localhost:5173/relay/api/sessions/x/ws",
    fragment,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    events: {
      onStatus: (status, detail) => recorded.statuses.push({ status, detail }),
      onData: (bytes, reset) => recorded.writes.push({ text: new TextDecoder().decode(bytes), reset }),
      onReadOnly: (value) => recorded.readOnly.push(value),
    },
  });
  return { connection, recorded };
}

const SALT = "#salt=" + btoa(String.fromCharCode(...new Uint8Array(16).fill(7)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/*
 * Decryption is asynchronous and queued, and PBKDF2 competes for the CPU, so a
 * fixed pause is a coin flip. Wait for the condition instead.
 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  FakeSocket.last = null;
  FakeSocket.created = 0;
  vi.useRealTimers();
});

describe("plaintext session", () => {
  it("reports connected and writes output", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(encodeFrame(Opcode.Output, new TextEncoder().encode("hello")));
    await waitFor(() => recorded.writes.length > 0, "the output frame");

    expect(recorded.statuses.map((s) => s.status)).toEqual(["connecting", "connected"]);
    expect(recorded.writes).toEqual([{ text: "hello", reset: false }]);
  });

  it("clears the screen for a snapshot but not for output", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(encodeFrame(Opcode.Snapshot, new TextEncoder().encode("restored")));
    FakeSocket.last!.binary(encodeFrame(Opcode.Output, new TextEncoder().encode("live")));
    await waitFor(() => recorded.writes.length === 2, "both frames");

    expect(recorded.writes).toEqual([
      { text: "restored", reset: true },
      { text: "live", reset: false },
    ]);
  });

  it("sends typed input as an Input frame", async () => {
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.send("ls\r");
    await waitFor(() => FakeSocket.last!.sent.length > 0, "the input frame");

    const sent = new Uint8Array(FakeSocket.last!.sent[0] as ArrayBuffer);
    expect(sent[0]).toBe(Opcode.Input);
    expect(new TextDecoder().decode(sent.subarray(1))).toBe("ls\r");
  });

  it("drops input on a read-only session", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.control({ readOnly: true });
    connection.send("rm -rf /\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded.readOnly).toEqual([true]);
    expect(FakeSocket.last!.sent).toHaveLength(0);
  });

  it("sends a resize once and not again for the same size", async () => {
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.resize(80, 24);
    connection.resize(80, 24);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(FakeSocket.last!.sent).toHaveLength(1);
    expect(new Uint8Array(FakeSocket.last!.sent[0] as ArrayBuffer)[0]).toBe(Opcode.Resize);
  });

  it("ignores a nonsense size", async () => {
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.resize(0, 0);
    connection.resize(-1, 24);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeSocket.last!.sent).toHaveLength(0);
  });

  it("re-asserts the size after a reconnect", async () => {
    /* The PTY follows this viewer, so a fresh socket has to be told again. */
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.resize(120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = FakeSocket.last!;

    first.closedWith(1006);
    await new Promise((resolve) => setTimeout(resolve, 900));
    FakeSocket.last!.opened();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(FakeSocket.created).toBe(2);
    expect(new Uint8Array(FakeSocket.last!.sent[0] as ArrayBuffer)[0]).toBe(Opcode.Resize);
  });
});

describe("session lifecycle", () => {
  it("reports a session that has ended and does not retry", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.closedWith(4000);
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(recorded.statuses.at(-1)?.status).toBe("ended");
    expect(FakeSocket.created).toBe(1);
  });

  it("reports a session that does not exist and does not retry", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.closedWith(4004);
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(recorded.statuses.at(-1)?.status).toBe("missing");
    expect(FakeSocket.created).toBe(1);
  });

  it("reports exit from a control message", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.control({ status: "exited" });
    expect(recorded.statuses.at(-1)?.status).toBe("ended");
  });

  it("retries after an unexpected drop", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.closedWith(1006);
    expect(recorded.statuses.at(-1)?.status).toBe("disconnected");

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(FakeSocket.created).toBe(2);
  });

  it("stops retrying once closed", async () => {
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.close();
    FakeSocket.last!.closedWith(1006);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(FakeSocket.created).toBe(1);
  });
});

describe("encrypted session", () => {
  it("asks for a password before opening a socket", async () => {
    const { connection, recorded } = connect(SALT);
    await connection.start();

    expect(recorded.statuses.map((s) => s.status)).toEqual(["needs-password"]);
    /* Connecting before a key exists would only produce undecryptable frames. */
    expect(FakeSocket.created).toBe(0);
    expect(connection.needsPassword).toBe(true);
    expect(connection.isEncrypted).toBe(true);
  });

  it("connects and decrypts once the password is supplied", async () => {
    const { connection, recorded } = connect(SALT);
    await connection.start();
    await connection.submitPassword("hunter2");
    expect(FakeSocket.created).toBe(1);

    const cipher = await BrowserFrameCipher.fromPassword(
      "hunter2",
      new Uint8Array(16).fill(7),
    );
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(
      await cipher.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("secret"))),
    );
    await waitFor(() => recorded.writes.length > 0, "the decrypted frame");

    expect(recorded.writes).toEqual([{ text: "secret", reset: false }]);
  });

  it("asks again when the password cannot decrypt", async () => {
    const { connection, recorded } = connect(SALT);
    await connection.start();
    await connection.submitPassword("wrong");

    const other = await BrowserFrameCipher.fromPassword(
      "right",
      new Uint8Array(16).fill(7),
    );
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(
      await other.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("secret"))),
    );
    await waitFor(
      () => recorded.statuses.at(-1)?.status === "needs-password",
      "the failed decryption to be reported",
    );

    const last = recorded.statuses.at(-1);
    expect(last?.status).toBe("needs-password");
    expect(last?.detail).toContain("could not decrypt");
    /* Nothing undecryptable should have reached the screen. */
    expect(recorded.writes).toEqual([]);
  });

  it("does not retry into a loop after a decryption failure", async () => {
    const { connection } = connect(SALT);
    await connection.start();
    await connection.submitPassword("wrong");

    const other = await BrowserFrameCipher.fromPassword("right", new Uint8Array(16).fill(7));
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(await other.seal(encodeFrame(Opcode.Output, new Uint8Array([65]))));
    /* Long enough that a retry would have fired if one were scheduled. */
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(FakeSocket.created).toBe(1);
  });

  it("encrypts outgoing input", async () => {
    const { connection } = connect(SALT);
    await connection.start();
    await connection.submitPassword("hunter2");
    FakeSocket.last!.opened();
    connection.send("whoami\r");
    await waitFor(() => FakeSocket.last!.sent.length > 0, "the sealed input frame");

    const sent = new Uint8Array(FakeSocket.last!.sent[0] as ArrayBuffer);
    /* Opcode stays in the clear as AAD; the payload must not be readable. */
    expect(sent[0]).toBe(Opcode.Input);
    expect(new TextDecoder().decode(sent.subarray(1))).not.toContain("whoami");
  });
});

describe("resize safety", () => {
  async function connected() {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    return { connection, recorded, socket: FakeSocket.last! };
  }

  function resizes(socket: FakeSocket) {
    return socket.sent
      .map((payload) => new Uint8Array(payload as ArrayBuffer))
      .filter((frame) => frame[0] === Opcode.Resize)
      .map((frame) => {
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        return { cols: view.getUint16(1), rows: view.getUint16(3) };
      });
  }

  it("refuses a size a real terminal would never have", async () => {
    /*
     * A hidden pane used to measure about one column wide. Forwarding that
     * resized the shared PTY to one column and wrecked anything full-screen.
     */
    const { connection, socket } = await connected();
    connection.resize(1, 24);
    connection.resize(80, 1);
    connection.resize(2, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resizes(socket)).toEqual([]);
  });

  it("keeps the last good size when a degenerate one arrives", async () => {
    const { connection, socket } = await connected();
    connection.resize(120, 40);
    connection.resize(1, 1);
    connection.resize(120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));

    /* The second 120x40 is a duplicate of the size still in force, not a
       recovery from the sliver, so exactly one resize should have gone out. */
    expect(resizes(socket)).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("still accepts a small but plausible terminal", async () => {
    const { connection, socket } = await connected();
    connection.resize(20, 4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resizes(socket)).toEqual([{ cols: 20, rows: 4 }]);
  });

  it("ignores a non-finite size rather than sending garbage", async () => {
    const { connection, socket } = await connected();
    connection.resize(Number.NaN, 24);
    connection.resize(80, Number.POSITIVE_INFINITY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resizes(socket)).toEqual([]);
  });
});
