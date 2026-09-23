import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalConnection, type ConnectionStatus, type HostState } from "./connection";
import { Opcode, encodeFrame } from "./protocol";
import { BrowserFrameCipher } from "./e2ee";
import * as analytics from "../../../web/posthog";
import {
  DESKTOP_TERMINAL_GRID,
  LEGACY_MOBILE_TERMINAL_GRID,
  MOBILE_TERMINAL_GRID,
  type TerminalGrid,
} from "./terminal-grid";

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
  grids: TerminalGrid[];
  hostStates: HostState[];
  mcpAuthorizations: boolean[];
}

function connect(fragment = "") {
  const recorded: Recorded = { statuses: [], writes: [], readOnly: [], grids: [], hostStates: [], mcpAuthorizations: [] };
  const connection = new TerminalConnection({
    url: "ws://localhost:5173/relay/api/sessions/x/ws",
    fragment,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    events: {
      onMcpAuthorization: (value) => recorded.mcpAuthorizations.push(value),
      onStatus: (status, detail) => recorded.statuses.push({ status, detail }),
      onData: (bytes, reset) => recorded.writes.push({ text: new TextDecoder().decode(bytes), reset }),
      onReadOnly: (value) => recorded.readOnly.push(value),
      onGrid: (grid) => recorded.grids.push(grid),
      onHostState: (state) => recorded.hostStates.push(state),
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

afterEach(() => vi.restoreAllMocks());

describe("stale socket callbacks", () => {
  it("separates handshake attempts, admission, capacity denial and intentional close", async () => {
    const rows: Array<{ name: string; results: string[] }> = [];
    vi.spyOn(analytics, "beginProductOperation").mockImplementation(name => {
      const row = { name, results: [] as string[] }; rows.push(row);
      let done = false; return result => { if (!done) { done = true; row.results.push(result); } };
    });
    const denied = connect(); await denied.connection.start(); FakeSocket.last!.opened();
    expect(rows[0].results).toEqual([]); // opening WebSocket is not session admission
    FakeSocket.last!.closedWith(4005); denied.connection.close();
    expect(rows[0]).toEqual({ name: "terminal_connect", results: ["limited"] });
    const allowed = connect(); await allowed.connection.start(); FakeSocket.last!.opened();
    FakeSocket.last!.control({ type: "status", status: "connected" });
    FakeSocket.last!.control({ type: "status", status: "connected" });
    allowed.connection.close();
    expect(rows[1]).toEqual({ name: "terminal_connect", results: ["ok"] });
    const pending = connect(); await pending.connection.start(); pending.connection.close();
    expect(rows[2]).toEqual({ name: "terminal_connect", results: ["cancelled"] });
  });
  it("does not deliver a frame whose decryption finishes after close", async () => {
    const { connection, recorded } = connect(`${SALT}&password=hunter2`);
    await connection.start();
    const socket = FakeSocket.last!;
    socket.opened();
    let finish!: (frame: Uint8Array<ArrayBuffer>) => void;
    const opening = vi.spyOn(BrowserFrameCipher.prototype, "open").mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    socket.binary(new Uint8Array([1]));
    await waitFor(() => opening.mock.calls.length === 1, "decryption to start");
    connection.close();
    finish(encodeFrame(Opcode.Output, new TextEncoder().encode("stale")));
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded.writes).toEqual([]);
  });

  it("ignores old socket callbacks after reconnect", async () => {
    vi.useFakeTimers();
    const { connection, recorded } = connect();
    await connection.start();
    const old = FakeSocket.last!;
    old.opened();
    old.closedWith(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const current = FakeSocket.last!;
    expect(current).not.toBe(old);
    current.opened();
    const statuses = [...recorded.statuses];
    old.opened();
    old.control({ readOnly: true });
    old.binary(encodeFrame(Opcode.Output, new TextEncoder().encode("stale")));
    old.closedWith(4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(recorded.statuses).toEqual(statuses);
    expect(recorded.readOnly).toEqual([]);
    expect(recorded.writes).toEqual([]);
    expect(FakeSocket.created).toBe(2);
    current.binary(encodeFrame(Opcode.Output, new TextEncoder().encode("current")));
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded.writes).toEqual([{ text: "current", reset: false }]);
    connection.close();
  });

  it("does not discard a new password when an old decryption fails", async () => {
    const { connection, recorded } = connect(`${SALT}&password=hunter2`);
    await connection.start();
    const old = FakeSocket.last!;
    old.opened();
    let fail!: (reason: Error) => void;
    const opening = vi.spyOn(BrowserFrameCipher.prototype, "open").mockImplementationOnce(
      () => new Promise((_resolve, reject) => { fail = reject; }),
    );
    old.binary(new Uint8Array([1]));
    await waitFor(() => opening.mock.calls.length === 1, "decryption to start");
    await connection.submitPassword("replacement");
    const current = FakeSocket.last!;
    current.opened();
    fail(new Error("old decryption failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.needsPassword).toBe(false);
    expect(recorded.statuses.at(-1)?.status).toBe("connected");
    const hostCipher = await BrowserFrameCipher.fromPassword("replacement", new Uint8Array(16).fill(7));
    current.binary(await hostCipher.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("current"))));
    await waitFor(() => recorded.writes.length > 0, "new key to decrypt");
    expect(recorded.writes).toEqual([{ text: "current", reset: false }]);
    connection.close();
  });
});

describe("plaintext session", () => {
  it("requests recovery only on an open socket, including read-only viewers", async () => {
    const { connection } = connect();
    await connection.start();
    const socket = FakeSocket.last!;
    connection.requestSnapshot();
    expect(socket.sent).toHaveLength(0);
    socket.opened();
    socket.control({ readOnly: true });
    connection.requestSnapshot();
    expect(socket.sent).toEqual([JSON.stringify({ type: "snapshot_request" })]);
    socket.close();
    connection.requestSnapshot();
    expect(socket.sent).toHaveLength(1);
    connection.close();
  });

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

  it("treats a recovery broadcast as a full-screen snapshot", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(encodeFrame(Opcode.BroadcastSnapshot, new TextEncoder().encode("recovered")));
    await waitFor(() => recorded.writes.length === 1, "the recovery snapshot");

    expect(recorded.writes).toEqual([{ text: "recovered", reset: true }]);
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

  it("sends binary input as raw bytes without UTF-8 re-encoding", async () => {
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    // ESC M (X10 mouse report) followed by bytes above 127. A TextEncoder
    // path would widen 0x80/0xff into two-byte UTF-8 sequences.
    connection.sendBinary("\u001bM\u0080\u00ff");
    await waitFor(() => FakeSocket.last!.sent.length > 0, "the binary input frame");

    const sent = new Uint8Array(FakeSocket.last!.sent[0] as ArrayBuffer);
    expect(sent[0]).toBe(Opcode.Input);
    expect(Array.from(sent.subarray(1))).toEqual([0x1b, 0x4d, 0x80, 0xff]);
  });

  it("drops binary input on a read-only session", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    FakeSocket.last!.control({ readOnly: true });
    connection.sendBinary("\u001bM\u0080\u00ff");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded.readOnly).toEqual([true]);
    expect(FakeSocket.last!.sent).toHaveLength(0);
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

  it("never asks the relay to resize the shared PTY", async () => {
    /*
     * The process keeps one grid for the whole session and every viewer scales
     * it locally. A viewer that sent its own size would be asking for a size
     * the relay discards anyway.
     */
    const { connection } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    connection.send("ls\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const opcodes = FakeSocket.last!.sent.map(
      (payload) => new Uint8Array(payload as ArrayBuffer)[0],
    );
    expect(opcodes).not.toContain(Opcode.Resize);
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

  it("reports a full session and retries until a viewer slot opens", async () => {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.closedWith(4005);

    expect(recorded.statuses.at(-1)?.status).toBe("full");
    expect(recorded.statuses.at(-1)?.detail).toContain("16 viewers");

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(FakeSocket.created).toBe(2);
    expect(recorded.statuses.at(-1)?.status).toBe("full");

    FakeSocket.last!.opened();
    expect(recorded.statuses.at(-1)?.status).toBe("full");
    FakeSocket.last!.control({ type: "welcome" });
    expect(recorded.statuses.at(-1)?.status).toBe("connected");
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
  it("uses a password embedded in the fragment without prompting", async () => {
    const { connection, recorded } = connect(`${SALT}&password=hunter2`);
    await connection.start();

    expect(FakeSocket.created).toBe(1);
    expect(connection.needsPassword).toBe(false);
    expect(recorded.statuses.map((s) => s.status)).toEqual(["connecting"]);
  });

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

  it("drops a replayed frame without treating the password as wrong", async () => {
    const { connection, recorded } = connect(`${SALT}&password=hunter2`);
    await connection.start();
    const host = await BrowserFrameCipher.fromPassword("hunter2", new Uint8Array(16).fill(7));
    FakeSocket.last!.opened();
    const frame = await host.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("once")));
    FakeSocket.last!.binary(frame);
    FakeSocket.last!.binary(frame);
    await waitFor(() => recorded.writes.length > 0, "the first frame");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorded.writes).toEqual([{ text: "once", reset: false }]);
    expect(recorded.statuses.at(-1)?.status).not.toBe("needs-password");
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

  /*
   * The first frame that opens is what proves a password right. The pane
   * keeps a typed password, and seals it into the vault, only after this.
   */
  function watchUnlocks() {
    const unlocked: number[] = [];
    const statuses: { status: ConnectionStatus; detail?: string }[] = [];
    const connection = new TerminalConnection({
      url: "ws://localhost:5173/relay/api/sessions/x/ws",
      fragment: SALT,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      events: {
        onStatus: (status, detail) => statuses.push({ status, detail }),
        onData: () => undefined,
        onReadOnly: () => undefined,
        onGrid: () => undefined,
        onUnlocked: () => unlocked.push(1),
      },
    });
    return { connection, unlocked, statuses };
  }

  it("says when a password first opens a frame, and only once", async () => {
    const { connection, unlocked } = watchUnlocks();
    await connection.start();
    await connection.submitPassword("hunter2");
    const cipher = await BrowserFrameCipher.fromPassword("hunter2", new Uint8Array(16).fill(7));
    FakeSocket.last!.opened();
    for (const text of ["one", "two"]) {
      FakeSocket.last!.binary(await cipher.seal(encodeFrame(Opcode.Output, new TextEncoder().encode(text))));
    }
    await waitFor(() => unlocked.length > 0, "the first frame to open");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unlocked).toHaveLength(1);
  });

  it("does not say so for a password that cannot decrypt", async () => {
    const { connection, unlocked, statuses } = watchUnlocks();
    await connection.start();
    await connection.submitPassword("wrong");
    const other = await BrowserFrameCipher.fromPassword("right", new Uint8Array(16).fill(7));
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(await other.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("x"))));
    await waitFor(() => statuses.at(-1)?.status === "needs-password", "the failure");
    expect(unlocked).toEqual([]);
  });

  it("asks a second password to prove itself again", async () => {
    const { connection, unlocked, statuses } = watchUnlocks();
    await connection.start();
    await connection.submitPassword("wrong");
    const right = await BrowserFrameCipher.fromPassword("right", new Uint8Array(16).fill(7));
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(await right.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("x"))));
    await waitFor(() => statuses.at(-1)?.status === "needs-password", "the failure");

    await connection.submitPassword("right");
    FakeSocket.last!.opened();
    FakeSocket.last!.binary(await right.seal(encodeFrame(Opcode.Output, new TextEncoder().encode("y"))));
    await waitFor(() => unlocked.length > 0, "the right password to open a frame");
    expect(unlocked).toHaveLength(1);
  });
});

describe("the session grid", () => {
  async function connected() {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    return { connection, recorded, socket: FakeSocket.last! };
  }

  it("starts on the grid the CLI opens a PTY at", async () => {
    /*
     * A viewer that connects before the first announcement still has to draw
     * something, and desktop is what the process is actually running at.
     */
    const { connection } = await connected();
    expect(connection.grid).toEqual(DESKTOP_TERMINAL_GRID);
  });

  it("follows the relay onto the mobile grid and back", async () => {
    const { connection, recorded, socket } = await connected();
    socket.control({ type: "terminal_size", ...MOBILE_TERMINAL_GRID });
    expect(connection.grid).toEqual(MOBILE_TERMINAL_GRID);
    socket.control({ type: "terminal_size", ...DESKTOP_TERMINAL_GRID });
    expect(connection.grid).toEqual(DESKTOP_TERMINAL_GRID);
    expect(recorded.grids).toEqual([MOBILE_TERMINAL_GRID, DESKTOP_TERMINAL_GRID]);
  });

  it("reports a grid change once", async () => {
    const { recorded, socket } = await connected();
    socket.control({ type: "terminal_size", ...MOBILE_TERMINAL_GRID });
    socket.control({ type: "terminal_size", ...MOBILE_TERMINAL_GRID });
    expect(recorded.grids).toEqual([MOBILE_TERMINAL_GRID]);
  });

  it("still renders the legacy mobile grid from an older CLI", async () => {
    const { connection, socket } = await connected();
    socket.control({ type: "terminal_size", ...LEGACY_MOBILE_TERMINAL_GRID });
    expect(connection.grid).toEqual(LEGACY_MOBILE_TERMINAL_GRID);
  });

  it("refuses a grid the CLI would reject", async () => {
    /*
     * cmd/shell/session_unix.go only resizes the PTY to a canonical grid.
     * Drawing anything else means rendering a shape the
     * process is not writing, which is the bug this whole model prevents.
     */
    const { connection, recorded, socket } = await connected();
    socket.control({ type: "terminal_size", cols: 94, rows: 28 });
    socket.control({ type: "terminal_size", cols: 0, rows: 0 });
    socket.control({ type: "terminal_size", cols: "120", rows: "36" });
    expect(connection.grid).toEqual(DESKTOP_TERMINAL_GRID);
    expect(recorded.grids).toEqual([]);
  });

  it("keeps the grid across a reconnect", async () => {
    const { connection, socket } = await connected();
    socket.control({ type: "terminal_size", ...MOBILE_TERMINAL_GRID });
    socket.closedWith(1006);
    await new Promise((resolve) => setTimeout(resolve, 900));
    FakeSocket.last!.opened();

    expect(FakeSocket.created).toBe(2);
    expect(connection.grid).toEqual(MOBILE_TERMINAL_GRID);
  });
});

/*
 * The relay reports the machine's state on every status message. Before this
 * the app read only "exited" and left the rest on the floor, so a viewer whose
 * machine had gone offline sat in front of a blank terminal that claimed to be
 * connected. The reproduction was a laptop that rebooted mid-session: the
 * session stayed on the relay for twelve hours, and every viewer since got an
 * empty screen with nothing said about it.
 */
describe("the machine behind the session", () => {
  async function connected() {
    const { connection, recorded } = connect();
    await connection.start();
    FakeSocket.last!.opened();
    return { connection, recorded, socket: FakeSocket.last! };
  }

  it("reports a machine that is away, with when it was last seen", async () => {
    const { recorded, socket } = await connected();
    socket.control({
      type: "status",
      status: "disconnected",
      hostLastSeenAt: "2026-09-15T20:42:00.000Z",
      lastScreenAt: "2026-09-15T20:41:00.000Z",
    });

    expect(recorded.hostStates).toEqual([{
      presence: "disconnected",
      lastSeenAt: "2026-09-15T20:42:00.000Z",
      screenCapturedAt: "2026-09-15T20:41:00.000Z",
    }]);
    /* The viewer's own socket is fine; only the machine is away. */
    expect(recorded.statuses.at(-1)?.status).toBe("connected");
  });

  it("reports a session whose machine has never connected", async () => {
    const { recorded, socket } = await connected();
    socket.control({ type: "status", status: "waiting" });
    expect(recorded.hostStates).toEqual([{
      presence: "waiting",
      lastSeenAt: undefined,
      screenCapturedAt: undefined,
    }]);
  });

  it("tracks MCP authorization independently of an empty agent activity list", async () => {
    const { recorded, socket } = await connected();
    socket.control({ type: "presence", mcpDecrypt: true, agents: [{ label: "helper" }] });
    socket.control({ type: "presence", mcpDecrypt: true, agents: [] });
    socket.control({ type: "status", status: "connected" });
    socket.control({ type: "presence", mcpDecrypt: false, agents: [] });
    expect(recorded.mcpAuthorizations).toEqual([true, true, false]);
  });

  it("reports the machine coming back", async () => {
    const { recorded, socket } = await connected();
    socket.control({ type: "status", status: "disconnected" });
    socket.control({ type: "status", status: "connected" });
    expect(recorded.hostStates.map((state) => state.presence)).toEqual(["disconnected", "connected"]);
  });

  it("ignores a status it does not know", async () => {
    const { recorded, socket } = await connected();
    socket.control({ type: "status", status: "something-new" });
    expect(recorded.hostStates).toEqual([]);
  });
});
