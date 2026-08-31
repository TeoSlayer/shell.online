import { describe, expect, it } from "vitest";
import { TerminalWriteQueue, type TerminalWriteTarget } from "../web/terminal-writes";

class FakeTerminal implements TerminalWriteTarget {
  readonly writes: number[][] = [];
  readonly completions: Array<() => void> = [];
  resets = 0;

  reset(): void {
    this.resets += 1;
  }

  write(data: Uint8Array, callback?: () => void): void {
    this.writes.push([...data]);
    if (callback) this.completions.push(callback);
  }

  completeNext(): void {
    const callback = this.completions.shift();
    if (!callback) throw new Error("No write is pending");
    callback();
  }
}

describe("mobile terminal write queue", () => {
  it("writes the first update immediately and coalesces queued frames", () => {
    const terminal = new FakeTerminal();
    const queue = new TerminalWriteQueue(terminal, 8);

    queue.enqueue(new Uint8Array([1]));
    queue.enqueue(new Uint8Array([2, 3]));
    queue.enqueue(new Uint8Array([4]));
    expect(terminal.writes).toEqual([[1]]);

    terminal.completeNext();
    expect(terminal.writes).toEqual([[1], [2, 3, 4]]);
  });

  it("splits large snapshots into bounded render jobs", () => {
    const terminal = new FakeTerminal();
    const queue = new TerminalWriteQueue(terminal, 4);

    queue.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]), true);
    expect(terminal.resets).toBe(1);
    expect(terminal.writes).toEqual([[1, 2, 3, 4]]);

    terminal.completeNext();
    expect(terminal.writes).toEqual([[1, 2, 3, 4], [5, 6]]);
  });

  it("drops stale queued output when a fresh snapshot arrives", () => {
    const terminal = new FakeTerminal();
    const queue = new TerminalWriteQueue(terminal, 8);

    queue.enqueue(new Uint8Array([1]));
    queue.enqueue(new Uint8Array([2]));
    queue.enqueue(new Uint8Array([9, 9]), true);
    terminal.completeNext();

    expect(terminal.resets).toBe(1);
    expect(terminal.writes).toEqual([[1], [9, 9]]);
  });

  it("bounds a slow renderer and requires a fresh snapshot to recover", () => {
    const terminal = new FakeTerminal();
    const queue = new TerminalWriteQueue(terminal, 8, 4);

    expect(queue.enqueue(new Uint8Array([1]))).toBe(true);
    expect(queue.enqueue(new Uint8Array([2, 3, 4, 5, 6]))).toBe(false);
    expect(queue.enqueue(new Uint8Array([7]))).toBe(false);
    expect(queue.enqueue(new Uint8Array([9, 9]), true)).toBe(true);
    terminal.completeNext();

    expect(terminal.writes).toEqual([[1], [9, 9]]);
  });
});
