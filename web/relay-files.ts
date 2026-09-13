import { encodeFrame, Opcode } from "../shared/protocol";

export interface RelayFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
}

export interface RelayFileResource {
  name: string;
  mimeType: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

interface ControlMessage {
  id: number;
  type: "capabilities" | "list" | "meta" | "error";
  root?: string;
  path?: string;
  entries?: RelayFileEntry[];
  name?: string;
  mimeType?: string;
  size?: number;
  token?: string;
  code?: string;
  message?: string;
}

interface Transfer {
  id: number;
  path: string;
  purpose: "preview" | "download";
  offset: number;
  token: string;
  inFlight: boolean;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  resolve(value: RelayFileResource | null): void;
  reject(error: Error): void;
  settled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  signal: AbortSignal;
}

type Sender = (frame: Uint8Array<ArrayBuffer>) => void;
type Disposable = { dispose(): void };

const CONTROL_KIND = 1;
const CHUNK_KIND = 2;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Browser half of shell.online's optional relay-backed file protocol.
 *
 * Requests use the terminal's existing E2EE frame cipher. The relay sees an
 * opcode and requester id for routing, but never a path or file byte.
 */
export class RelayFileClient {
  private nextId = 0;
  private sender: Sender;
  private transfers = new Map<number, Transfer>();
  private lists = new Map<number, { resolve(entries: RelayFileEntry[]): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<() => void>();
  private availability = new Set<(available: boolean) => void>();
  private probing = new Set<number>();
  private disposed = false;
  root = "files";
  available = false;

  constructor(sender: Sender) {
    this.sender = sender;
  }

  setSender(sender: Sender): void {
    this.sender = sender;
  }

  probe(): void {
    if (this.disposed) return;
    const id = this.id();
    this.probing.add(id);
    this.send({ id, type: "capabilities" });
    globalThis.setTimeout(() => this.probing.delete(id), 3_000);
  }

  onAvailability(listener: (available: boolean) => void): Disposable {
    this.availability.add(listener);
    listener(this.available);
    return { dispose: () => this.availability.delete(listener) };
  }

  onChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async list(path = ""): Promise<RelayFileEntry[]> {
    if (!this.available || this.disposed) return [];
    const id = this.id();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.lists.delete(id);
        reject(new Error("File listing timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.lists.set(id, { resolve, reject, timeout });
      this.send({ id, type: "list", path });
    });
  }

  resolve(path: string, request: { purpose: "preview" | "download"; signal: AbortSignal }): Promise<RelayFileResource | null> {
    if (!this.available || this.disposed || request.signal.aborted) return Promise.resolve(null);
    const id = this.id();
    return new Promise((resolve, reject) => {
      const transfer: Transfer = {
        id, path, purpose: request.purpose, offset: 0, token: "", inFlight: false,
        resolve, reject, settled: false, signal: request.signal,
      };
      const abort = () => this.failTransfer(transfer, new DOMException("File request cancelled.", "AbortError"));
      transfer.abort = abort;
      request.signal.addEventListener("abort", abort, { once: true });
      transfer.timeout = globalThis.setTimeout(() => this.failTransfer(transfer, new Error("File request timed out.")), REQUEST_TIMEOUT_MS);
      this.transfers.set(id, transfer);
      this.pull(transfer);
    });
  }

  readonly fileLinks = {
    // --files explicitly grants access to the scoped root. Detection remains
    // local; the CLI is still authoritative and rejects escapes/non-files.
    canResolve: (reference: { path: string }): boolean => this.available && Boolean(reference.path),
    onChange: (listener: () => void): Disposable => this.onChange(listener),
    resolve: (reference: { path: string }, request: { purpose: "preview" | "download"; signal: AbortSignal }) =>
      this.resolve(reference.path, request),
  };

  handle(frame: Uint8Array): boolean {
    if (frame[0] !== Opcode.FileResponse || frame.byteLength < 3) return false;
    if (frame[1] === CONTROL_KIND) {
      this.handleControl(frame.subarray(2));
      return true;
    }
    if (frame[1] === CHUNK_KIND) {
      this.handleChunk(frame);
      return true;
    }
    return true;
  }

  reset(): void {
    if (this.available) {
      this.available = false;
      for (const listener of this.availability) listener(false);
      for (const listener of this.listeners) listener();
    }
    for (const transfer of [...this.transfers.values()]) this.failTransfer(transfer, new Error("File connection ended."));
    for (const [id, pending] of this.lists) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("File connection ended."));
      this.lists.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
    this.listeners.clear();
    this.availability.clear();
  }

  private id(): number {
    this.nextId = this.nextId >= 0xffff_ffff ? 1 : this.nextId + 1;
    return this.nextId;
  }

  private send(message: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    this.sender(encodeFrame(Opcode.FileRequest, bytes));
  }

  private pull(transfer: Transfer): void {
    if (transfer.inFlight || !this.transfers.has(transfer.id)) return;
    transfer.inFlight = true;
    this.send({
      id: transfer.id,
      type: "read",
      path: transfer.path,
      purpose: transfer.purpose,
      offset: transfer.offset,
      ...(transfer.token ? { token: transfer.token } : {}),
    });
  }

  private handleControl(bytes: Uint8Array): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(new TextDecoder().decode(bytes)) as ControlMessage;
    } catch {
      return;
    }
    if (!Number.isInteger(message.id) || message.id <= 0) return;
    if (message.type === "capabilities" && this.probing.delete(message.id)) {
      this.root = typeof message.root === "string" && message.root ? message.root : "files";
      if (!this.available) {
        this.available = true;
        for (const listener of this.availability) listener(true);
        for (const listener of this.listeners) listener();
      }
      return;
    }
    if (message.type === "list") {
      const pending = this.lists.get(message.id);
      if (!pending) return;
      this.lists.delete(message.id);
      clearTimeout(pending.timeout);
      const entries = Array.isArray(message.entries) ? message.entries.filter(validEntry) : [];
      pending.resolve(entries);
      return;
    }
    const transfer = this.transfers.get(message.id);
    if (!transfer) return;
    if (message.type === "error") {
      this.failTransfer(transfer, new Error(message.message || "File unavailable."));
      return;
    }
    if (message.type !== "meta" || transfer.settled || typeof message.name !== "string" ||
      typeof message.mimeType !== "string" || typeof message.size !== "number" || typeof message.token !== "string") return;
    transfer.token = message.token;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { transfer.controller = controller; },
      pull: () => this.pull(transfer),
      cancel: () => this.finishTransfer(transfer),
    }, { highWaterMark: 0 });
    transfer.settled = true;
    transfer.resolve({ name: message.name, mimeType: message.mimeType, size: message.size, body });
  }

  private handleChunk(frame: Uint8Array): void {
    if (frame.byteLength < 15) return;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = view.getUint32(2);
    const offset = Number(view.getBigUint64(6));
    const transfer = this.transfers.get(id);
    if (!transfer || offset !== transfer.offset) return;
    transfer.inFlight = false;
    clearTimeout(transfer.timeout);
    transfer.timeout = globalThis.setTimeout(() => this.failTransfer(transfer, new Error("File request timed out.")), REQUEST_TIMEOUT_MS);
    const chunk = new Uint8Array(frame.subarray(15));
    transfer.offset += chunk.byteLength;
    if (chunk.byteLength) transfer.controller?.enqueue(chunk);
    if (frame[14] === 1) this.finishTransfer(transfer);
  }

  private finishTransfer(transfer: Transfer): void {
    if (!this.transfers.delete(transfer.id)) return;
    clearTimeout(transfer.timeout);
    if (transfer.abort) transfer.signal.removeEventListener("abort", transfer.abort);
    transfer.controller?.close();
    if (!transfer.settled) transfer.resolve(null);
  }

  private failTransfer(transfer: Transfer, error: Error): void {
    if (!this.transfers.delete(transfer.id)) return;
    clearTimeout(transfer.timeout);
    if (transfer.abort) transfer.signal.removeEventListener("abort", transfer.abort);
    if (transfer.settled) transfer.controller?.error(error);
    else transfer.reject(error);
  }
}

function validEntry(value: unknown): value is RelayFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RelayFileEntry>;
  return typeof entry.path === "string" && typeof entry.name === "string" &&
    (entry.kind === "file" || entry.kind === "directory") &&
    (entry.size === undefined || Number.isSafeInteger(entry.size) && entry.size >= 0);
}
