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
  private encoding = false;
  private generation = 0;

  constructor(
    private readonly getSocket: () => InputSocket | null,
    private readonly maximumBufferedBytes = 256 * 1024,
    private readonly maximumPendingBytes = 1024 * 1024,
    private encoder: (chunk: Uint8Array) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> =
      (chunk) => encodeFrame(Opcode.Input, chunk),
  ) {}

  setEncoder(encoder: (chunk: Uint8Array) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): void {
    this.encoder = encoder;
  }

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
    this.generation += 1;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  flush(): void {
    this.timer = undefined;
    const socket = this.getSocket();
    if (!socket || socket.readyState !== 1 || this.encoding) return;
    while (this.pending.length > 0 && socket.bufferedAmount < this.maximumBufferedBytes) {
      const chunk = this.pending.shift()!;
      this.pendingBytes -= chunk.byteLength;
      const frame = this.encoder(chunk);
      if (frame instanceof Promise) {
        const generation = this.generation;
        this.encoding = true;
        void frame.then((encoded) => {
          const current = this.getSocket();
          if (generation === this.generation && current?.readyState === 1) current.send(encoded);
        }).finally(() => {
          this.encoding = false;
          this.flush();
        });
        return;
      }
      socket.send(frame);
    }
    if (this.pending.length > 0) {
      this.timer = globalThis.setTimeout(() => this.flush(), 16);
    }
  }
}
