import { Opcode, encodeFrame, isSnapshotOpcode } from "./protocol";
import { BrowserFrameCipher, parseEncryptionFragment, type EncryptionFragment } from "./e2ee";
import {
  DESKTOP_TERMINAL_GRID,
  MOBILE_TERMINAL_GRID,
  type TerminalGrid,
} from "./terminal-grid";

export type ConnectionStatus =
  | "connecting"
  | "needs-password"
  | "connected"
  | "full"
  | "disconnected"
  | "ended"
  | "missing"
  | "error";

export interface ConnectionEvents {
  onStatus(status: ConnectionStatus, detail?: string): void;
  /** Terminal bytes to write. `reset` means the screen should be cleared first. */
  onData(bytes: Uint8Array, reset: boolean): void;
  onReadOnly(readOnly: boolean): void;
  /**
   * The grid the PTY is running at, announced by the relay. It is a property
   * of the session rather than of this viewer, and it changes when a phone
   * joins or leaves.
   */
  onGrid(grid: TerminalGrid): void;
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

const CLOSE_ENDED = 4000;
const CLOSE_MISSING = 4004;
const CLOSE_DECRYPT_FAILED = 4003;
const CLOSE_SESSION_FULL = 4005;

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
  private waitingForCapacity = false;
  private currentGrid: TerminalGrid = DESKTOP_TERMINAL_GRID;

  constructor(private readonly options: ConnectionOptions) {
    this.descriptor = parseEncryptionFragment(options.fragment);
  }

  /**
   * The grid the PTY is running at.
   *
   * Desktop until the relay says otherwise, which is what the CLI opens a PTY
   * at, so a viewer that connects before the first announcement still renders
   * at the right size instead of guessing from its own pixels.
   */
  get grid(): TerminalGrid {
    return this.currentGrid;
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
    } else if (this.descriptor?.kind === "password" && this.descriptor.password) {
      this.cipher = await BrowserFrameCipher.fromPassword(this.descriptor.password, this.descriptor.salt);
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
    this.options.events.onStatus(this.waitingForCapacity ? "full" : "connecting");

    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url));
    const socket = create(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      // A deliberately rejected capacity socket still reaches "open" before
      // its 4005 close. Keep the honest waiting state until the relay sends a
      // real session message proving this retry was admitted.
      if (!this.waitingForCapacity) {
        this.retryAttempt = 0;
        this.options.events.onStatus("connected");
      }
    });

    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      this.markAdmitted();
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
      if (event.code === CLOSE_SESSION_FULL) {
        this.waitingForCapacity = true;
        this.options.events.onStatus(
          "full",
          "16 viewers are connected. You will join automatically when a slot opens.",
        );
        this.scheduleRetry();
        return;
      }
      if (this.awaitingPassword) return;
      this.options.events.onStatus("disconnected");
      this.scheduleRetry();
    });
  }

  private markAdmitted(): void {
    if (!this.waitingForCapacity) return;
    this.waitingForCapacity = false;
    this.retryAttempt = 0;
    this.options.events.onStatus("connected");
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
    if (isSnapshotOpcode(opcode)) {
      this.options.events.onData(frame.subarray(1), true);
    } else if (opcode === Opcode.Output) {
      this.options.events.onData(frame.subarray(1), false);
    }
  }

  private handleControl(raw: string): void {
    let message: { readOnly?: unknown; status?: unknown; type?: unknown; cols?: unknown; rows?: unknown };
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
    if (message.type === "terminal_size") {
      this.adoptGrid(message.cols, message.rows);
    }
  }

  /*
   * Only the two grids the CLI will actually open a PTY at are honoured. It
   * refuses anything else (`isCanonicalTerminalSize`), so rendering a size it
   * would have rejected is how a viewer ends up drawing 94 columns of a
   * 120-column process.
   */
  private adoptGrid(cols: unknown, rows: unknown): void {
    if (typeof cols !== "number" || typeof rows !== "number") return;
    const grid = [DESKTOP_TERMINAL_GRID, MOBILE_TERMINAL_GRID].find(
      (candidate) => candidate.cols === cols && candidate.rows === rows,
    );
    if (!grid) return;
    if (grid.cols === this.currentGrid.cols && grid.rows === this.currentGrid.rows) return;
    this.currentGrid = grid;
    this.options.events.onGrid(grid);
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
