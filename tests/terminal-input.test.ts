import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INPUT_CHUNK, Opcode } from "../shared/protocol";
import { TerminalInputQueue, type InputSocket } from "../web/terminal-input";

class FakeSocket implements InputSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
}

afterEach(() => vi.useRealTimers());

describe("terminal input framing", () => {
  it("splits large paste input into Worker-safe frames without losing bytes", () => {
    const socket = new FakeSocket();
    const queue = new TerminalInputQueue(() => socket);
    const paste = new Uint8Array(50_000).map((_, index) => index % 251);
    expect(queue.enqueue(paste)).toBe(true);
    expect(socket.sent.every((frame) => frame[0] === Opcode.Input && frame.length <= MAX_INPUT_CHUNK + 1)).toBe(true);
    const restored = new Uint8Array(socket.sent.flatMap((frame) => [...frame.subarray(1)]));
    expect(restored).toEqual(paste);
  });

  it("waits for WebSocket backpressure and keeps pending input bounded", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 300_000;
    const queue = new TerminalInputQueue(() => socket, 256_000, 32);
    expect(queue.enqueue(new Uint8Array(32))).toBe(true);
    expect(queue.enqueue(new Uint8Array(1))).toBe(false);
    expect(socket.sent).toHaveLength(0);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(16);
    expect(socket.sent).toHaveLength(1);
  });
});
