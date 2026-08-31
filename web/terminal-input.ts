import { encodeFrame, MAX_INPUT_CHUNK, Opcode } from "../shared/protocol";

export interface InputSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array<ArrayBuffer>): void;
}

export class TerminalInputQueue {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly getSocket: () => InputSocket | null,
    private readonly maximumBufferedBytes = 256 * 1024,
    private readonly maximumPendingBytes = 1024 * 1024,
  ) {}

  enqueue(bytes: Uint8Array): boolean {
    if (bytes.byteLength + this.pendingBytes > this.maximumPendingBytes) return false;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK) {
      const chunk = new Uint8Array(bytes.subarray(offset, offset + MAX_INPUT_CHUNK));
      this.pending.push(chunk);
      this.pendingBytes += chunk.byteLength;
    }
    this.flush();
    return true;
  }

  clear(): void {
    this.pending = [];
    this.pendingBytes = 0;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  flush(): void {
    this.timer = undefined;
    const socket = this.getSocket();
    if (!socket || socket.readyState !== 1) return;
    while (this.pending.length > 0 && socket.bufferedAmount < this.maximumBufferedBytes) {
      const chunk = this.pending.shift()!;
      this.pendingBytes -= chunk.byteLength;
      socket.send(encodeFrame(Opcode.Input, chunk));
    }
    if (this.pending.length > 0) {
      this.timer = globalThis.setTimeout(() => this.flush(), 16);
    }
  }
}
