export interface TerminalWriteTarget {
  reset(): void;
  write(data: Uint8Array, callback?: () => void): void;
}

interface PendingTerminalWrite {
  data: Uint8Array;
  reset: boolean;
}

export class TerminalWriteQueue {
  private readonly pending: PendingTerminalWrite[] = [];
  private writing = false;

  constructor(
    private readonly target: TerminalWriteTarget,
    private readonly maximumBatchBytes: number,
  ) {}

  enqueue(data: Uint8Array, reset = false): void {
    if (reset) this.pending.length = 0;

    if (data.byteLength === 0) {
      this.pending.push({ data: new Uint8Array(), reset });
    } else {
      for (let offset = 0; offset < data.byteLength; offset += this.maximumBatchBytes) {
        const end = Math.min(data.byteLength, offset + this.maximumBatchBytes);
        this.pending.push({
          data: new Uint8Array(data.subarray(offset, end)),
          reset: reset && offset === 0,
        });
      }
    }

    this.flush();
  }

  private flush(): void {
    if (this.writing || this.pending.length === 0) return;

    const first = this.pending.shift()!;
    if (first.reset) this.target.reset();

    const chunks = [first.data];
    let byteLength = first.data.byteLength;
    while (
      this.pending.length > 0 &&
      !this.pending[0].reset &&
      byteLength + this.pending[0].data.byteLength <= this.maximumBatchBytes
    ) {
      const next = this.pending.shift()!;
      chunks.push(next.data);
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
      this.writing = false;
      this.flush();
    });
  }
}
