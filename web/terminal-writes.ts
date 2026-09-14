export interface TerminalWriteTarget {
  reset(): void;
  write(data: Uint8Array, callback?: () => void): void;
}

interface PendingTerminalWrite {
  data: Uint8Array;
  reset: boolean;
  complete?: () => void;
}

export class TerminalWriteQueue {
  private readonly pending: PendingTerminalWrite[] = [];
  private writing = false;
  private pendingBytes = 0;
  private desynchronized = false;

  constructor(
    private readonly target: TerminalWriteTarget,
    private readonly maximumBatchBytes: number,
    private readonly maximumPendingBytes = 1024 * 1024,
  ) {}

  enqueue(data: Uint8Array, reset = false, complete?: () => void): boolean {
    if (reset) {
      this.pending.length = 0;
      this.pendingBytes = 0;
      this.desynchronized = false;
    } else if (this.desynchronized || this.pendingBytes + data.byteLength > this.maximumPendingBytes) {
      this.pending.length = 0;
      this.pendingBytes = 0;
      this.desynchronized = true;
      return false;
    }

    if (data.byteLength === 0) {
      this.pending.push({ data: new Uint8Array(), reset, complete });
    } else {
      for (let offset = 0; offset < data.byteLength; offset += this.maximumBatchBytes) {
        const end = Math.min(data.byteLength, offset + this.maximumBatchBytes);
        this.pending.push({
          data: new Uint8Array(data.subarray(offset, end)),
          reset: reset && offset === 0,
          complete: end === data.byteLength ? complete : undefined,
        });
        this.pendingBytes += end - offset;
      }
    }

    this.flush();
    return true;
  }

  private flush(): void {
    if (this.writing || this.pending.length === 0) return;

    const first = this.pending.shift()!;
    this.pendingBytes -= first.data.byteLength;
    if (first.reset) this.target.reset();

    const chunks = [first.data];
    const completions: Array<() => void> = first.complete ? [first.complete] : [];
    let byteLength = first.data.byteLength;
    while (
      this.pending.length > 0 &&
      !this.pending[0].reset &&
      byteLength + this.pending[0].data.byteLength <= this.maximumBatchBytes
    ) {
      const next = this.pending.shift()!;
      this.pendingBytes -= next.data.byteLength;
      chunks.push(next.data);
      if (next.complete) completions.push(next.complete);
      byteLength += next.data.byteLength;
    }

    let output = chunks[0];
    if (chunks.length > 1) {
      output = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    this.writing = true;
    this.target.write(output, () => {
      for (const complete of completions) complete();
      this.writing = false;
      this.flush();
    });
  }
}
