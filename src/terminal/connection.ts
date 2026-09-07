import { Opcode, encodeFrame, encodeResize } from "./protocol";
import { BrowserFrameCipher, parseEncryptionFragment, type EncryptionFragment } from "./e2ee";

export type ConnectionStatus =
  | "connecting"
  | "needs-password"
  | "connected"
  | "disconnected"
  | "ended"
  | "missing"
  | "error";

export interface ConnectionEvents {
  onStatus(status: ConnectionStatus, detail?: string): void;
  /** Terminal bytes to write. `reset` means the screen should be cleared first. */
  onData(bytes: Uint8Array, reset: boolean): void;
  onReadOnly(readOnly: boolean): void;
}

export interface ConnectionOptions {
  url: string;
  /** The share URL fragment carrying `#salt=` or `#key=`, if any. */
  fragment: string;
  events: ConnectionEvents;
  /** Test seam. Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  /** Test seam for backoff. */
  now?: () => number;
}

const MAX_BACKOFF_MS = 10_000;

/*
 * Below this a terminal is not a terminal, it is a measurement artefact from a
 * pane that is not laid out yet or not on screen.
 */
const MIN_COLS = 20;
const MIN_ROWS = 4;
const CLOSE_ENDED = 4000;
const CLOSE_MISSING = 4004;
const CLOSE_DECRYPT_FAILED = 4003;

/**
 * One viewer connection to one session.
 *
 * Deliberately free of React and of xterm: it owns the socket, the retry
 * policy and the cipher, and hands plain bytes to whoever is rendering. That
 * keeps the parts worth testing testable without a DOM.
 */
export class TerminalConnection {
  private socket: WebSocket | null = null;
  private cipher: BrowserFrameCipher | null = null;
  private descriptor: EncryptionFragment | null;
  private queue: Promise<void> = Promise.resolve();
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readOnly = false;
  private awaitingPassword = false;
  private lastSize: { cols: number; rows: number } | null = null;

  constructor(private readonly options: ConnectionOptions) {
    this.descriptor = parseEncryptionFragment(options.fragment);
  }

  /** True when the session is encrypted and no working key is held yet. */
  get needsPassword(): boolean {
    return this.descriptor?.kind === "password" && !this.cipher;
  }

  get isEncrypted(): boolean {
    return this.descriptor !== null;
  }

  async start(): Promise<void> {
    if (this.descriptor?.kind === "key") {
      this.cipher = await BrowserFrameCipher.fromKey(this.descriptor.key);
    }
    if (this.needsPassword) {
      this.awaitingPassword = true;
      this.options.events.onStatus("needs-password");
      return;
    }
    this.open();
  }

  /**
   * Derives the key from a password and connects.
   *
   * A wrong password is only discovered when the first frame fails to open, so
   * the caller learns about it through a "needs-password" status carrying a
   * message rather than from this call.
   */
  async submitPassword(password: string): Promise<void> {
    if (this.descriptor?.kind !== "password") return;
    this.cipher = await BrowserFrameCipher.fromPassword(password, this.descriptor.salt);
    this.awaitingPassword = false;
    this.open();
  }

  send(data: string): void {
    if (this.readOnly) return;
    const bytes = new TextEncoder().encode(data);
    void this.transmit(encodeFrame(Opcode.Input, bytes));
  }

  /**
   * Reports this viewer's terminal size to the relay, which resizes the shared
   * PTY to match.
   *
   * A degenerate size is refused rather than sent. A hidden pane can measure
   * as a sliver, and forwarding that would resize the real PTY to a column or
   * two, destroying the layout of anything full-screen like htop. No terminal
   * that small is worth honouring, so the last good size stands.
   */
  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < MIN_COLS || rows < MIN_ROWS) return;
    /* The relay resizes the shared PTY, so only send an actual change. */
    if (this.lastSize?.cols === cols && this.lastSize.rows === rows) return;
    this.lastSize = { cols, rows };
    void this.transmit(encodeResize(cols, rows));
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already closing */
    }
  }

  private async transmit(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      const payload = this.cipher ? await this.cipher.seal(frame) : frame;
      if (this.socket === socket && socket.readyState === 1) socket.send(payload);
    } catch {
      /* a send that loses its socket mid-flight is not worth reporting */
    }
  }

  private open(): void {
    if (this.stopped) return;
    this.options.events.onStatus("connecting");

    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url));
    const socket = create(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryAttempt = 0;
      this.options.events.onStatus("connected");
      /* The PTY size follows this viewer, so re-assert it on every connect. */
      if (this.lastSize) {
        const { cols, rows } = this.lastSize;
        this.lastSize = null;
        this.resize(cols, rows);
      }
    });

    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") {
        this.handleControl(event.data);
        return;
      }
      const received = new Uint8Array(event.data);
      /* Frames are decrypted in order; AES-GCM opens are async. */
      this.queue = this.queue
        .then(() => this.handleFrame(received))
        .catch(() => undefined);
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      if (event.code === CLOSE_MISSING) {
        this.options.events.onStatus("missing");
        return;
      }
      if (event.code === CLOSE_ENDED) {
        this.options.events.onStatus("ended");
        return;
      }
      if (this.awaitingPassword) return;
      this.options.events.onStatus("disconnected");
      this.scheduleRetry();
    });
  }

  private async handleFrame(received: Uint8Array): Promise<void> {
    let frame = received;
    if (this.descriptor) {
      if (!this.cipher) return;
      try {
        frame = await this.cipher.open(received);
      } catch {
        /*
         * A frame that will not open means the derived key is wrong. Drop it,
         * stop retrying, and ask again rather than looping on bad output.
         */
        this.cipher = null;
        this.awaitingPassword = true;
        try {
          this.socket?.close(CLOSE_DECRYPT_FAILED, "decryption failed");
        } catch {
          /* already closing */
        }
        this.socket = null;
        this.options.events.onStatus(
          "needs-password",
          "That password could not decrypt this session.",
        );
        return;
      }
    }
    if (frame.byteLength === 0) return;

    const opcode = frame[0];
    if (opcode === Opcode.Snapshot || opcode === Opcode.FinalSnapshot) {
      this.options.events.onData(frame.subarray(1), true);
    } else if (opcode === Opcode.Output) {
      this.options.events.onData(frame.subarray(1), false);
    }
  }

  private handleControl(raw: string): void {
    let message: { readOnly?: unknown; status?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (typeof message.readOnly === "boolean") {
      this.readOnly = message.readOnly;
      this.options.events.onReadOnly(message.readOnly);
    }
    if (message.status === "exited") {
      this.options.events.onStatus("ended");
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, backoff + Math.random() * 250);
  }
}
