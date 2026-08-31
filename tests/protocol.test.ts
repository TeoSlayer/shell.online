import { describe, expect, it } from "vitest";
import {
  decodeLatencyProbe,
  decodeResize,
  encodeFrame,
  encodeLatencyProbe,
  encodeResize,
  Opcode,
} from "../shared/protocol";

describe("terminal wire protocol", () => {
  it("round-trips terminal dimensions", () => {
    expect(decodeResize(encodeResize(132, 43))).toEqual({ cols: 132, rows: 43 });
  });

  it("prefixes binary payloads without changing them", () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    expect([...encodeFrame(Opcode.Input, payload)]).toEqual([Opcode.Input, ...payload]);
  });

  it("reserves a recovery snapshot opcode distinct from targeted snapshots", () => {
    expect(Opcode.BroadcastSnapshot).toBe(0x08);
    expect(Opcode.BroadcastSnapshot).not.toBe(Opcode.Snapshot);
  });

  it("rejects malformed resize messages", () => {
    expect(decodeResize(new Uint8Array([Opcode.Resize, 0]))).toBeNull();
    expect(decodeResize(new Uint8Array([Opcode.Input, 0, 80, 0, 24]))).toBeNull();
  });

  it("round-trips latency tokens", () => {
    const ping = encodeLatencyProbe(0xfedcba98);
    expect(ping[0]).toBe(Opcode.Ping);
    ping[0] = Opcode.Pong;
    expect(decodeLatencyProbe(ping)).toBe(0xfedcba98);
    ping[0] = Opcode.Output;
    expect(decodeLatencyProbe(ping)).toBeNull();
  });
});
