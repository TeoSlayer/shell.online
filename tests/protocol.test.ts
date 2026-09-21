import { describe, expect, it } from "vitest";
import {
  decodeLatencyProbe,
  decodeResize,
  decodeSend,
  decodeSendAck,
  encodeFrame,
  encodeLatencyProbe,
  encodeResize,
  isSnapshotOpcode,
  encodeSend,
  encodeSendAck,
  Opcode,
  SEND_MAX_TEXT_BYTES,
} from "../shared/protocol";

const OP_ID = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const textBytes = (s: string) => new TextEncoder().encode(s);
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

describe("terminal wire protocol", () => {
  it("round-trips terminal dimensions", () => {
    expect(decodeResize(encodeResize(132, 43))).toEqual({ cols: 132, rows: 43 });
  });

  it("prefixes binary payloads without changing them", () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    expect([...encodeFrame(Opcode.Input, payload)]).toEqual([Opcode.Input, ...payload]);
  });

  it("keeps confirmed EOF distinct from ordinary input", () => {
    expect([...encodeFrame(Opcode.ConfirmedEOF, new Uint8Array())]).toEqual([Opcode.ConfirmedEOF]);
  });

  it("reserves a recovery snapshot opcode distinct from targeted snapshots", () => {
    expect(Opcode.BroadcastSnapshot).toBe(0x08);
    expect(Opcode.BroadcastSnapshot).not.toBe(Opcode.Snapshot);
  });

  it("treats targeted, final, and recovery frames as full snapshots", () => {
    expect(isSnapshotOpcode(Opcode.Snapshot)).toBe(true);
    expect(isSnapshotOpcode(Opcode.FinalSnapshot)).toBe(true);
    expect(isSnapshotOpcode(Opcode.BroadcastSnapshot)).toBe(true);
    expect(isSnapshotOpcode(Opcode.Output)).toBe(false);
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

  it("reserves distinct send opcodes for control delivery", () => {
    expect(Opcode.Send).toBe(0x0c);
    expect(Opcode.SendAck).toBe(0x0d);
    expect(new Set([Opcode.Send, Opcode.SendAck, Opcode.FileRequest, Opcode.FileResponse]).size).toBe(4);
    expect(Opcode.Send).not.toBe(Opcode.Input);
    expect(Opcode.SendAck).not.toBe(Opcode.ConfirmedEOF);
  });

  it("round-trips a send frame (text + optional enter + dispatch token)", () => {
    for (const enter of [false, true]) {
      const decoded = decodeSend(encodeSend(OP_ID, enter, TOKEN, textBytes("hello world")));
      expect(decoded).not.toBeNull();
      expect(decoded?.operationId).toBe(OP_ID);
      expect(decoded?.enter).toBe(enter);
      expect(bytesEqual(decoded?.dispatchToken ?? new Uint8Array(), TOKEN)).toBe(true);
      expect(new TextDecoder().decode(decoded?.text ?? new Uint8Array())).toBe("hello world");
    }
  });

  it("round-trips a multibyte send text", () => {
    const decoded = decodeSend(encodeSend(OP_ID, true, TOKEN, textBytes("héllo → 世界")));
    expect(new TextDecoder().decode(decoded?.text ?? new Uint8Array())).toBe("héllo → 世界");
    expect(bytesEqual(decoded?.dispatchToken ?? new Uint8Array(), TOKEN)).toBe(true);
  });

  it("rejects a send frame with a wrong dispatch token length", () => {
    // encode: an 8-byte token is rejected
    expect(() => encodeSend(OP_ID, true, new Uint8Array(8), textBytes("x"))).toThrow();
    expect(() => encodeSend(OP_ID, true, new Uint8Array(17), textBytes("x"))).toThrow();
    // decode: a frame whose token field is truncated is below the minimum length
    const shortToken = new Uint8Array(OP_ID.length + 1 + 8 + 1);
    shortToken.set(textBytes(OP_ID), 0);
    shortToken[OP_ID.length] = 1;
    expect(decodeSend(encodeFrame(Opcode.Send, shortToken))).toBeNull();
  });

  it("rejects malformed send frames", () => {
    // wrong opcode
    expect(decodeSend(encodeFrame(Opcode.Input, textBytes(OP_ID + "x")))).toBeNull();
    // empty text (just opId + enter + token)
    const empty = new Uint8Array(OP_ID.length + 1 + 16);
    empty.set(textBytes(OP_ID), 0);
    empty[OP_ID.length] = 0;
    expect(decodeSend(encodeFrame(Opcode.Send, empty))).toBeNull();
    // text over the cap
    const tooLong = new Uint8Array(SEND_MAX_TEXT_BYTES + 1);
    const over = new Uint8Array(OP_ID.length + 1 + 16 + tooLong.byteLength);
    over.set(textBytes(OP_ID), 0);
    over[OP_ID.length] = 0;
    over.set(tooLong, OP_ID.length + 1 + 16);
    expect(decodeSend(encodeFrame(Opcode.Send, over))).toBeNull();
  });

  it("round-trips a send-ack frame (operation id + dispatch token) and rejects a wrong opcode", () => {
    for (const result of [0x00, 0x01]) {
      const decoded = decodeSendAck(encodeSendAck(OP_ID, TOKEN, result));
      expect(decoded?.operationId).toBe(OP_ID);
      expect(bytesEqual(decoded?.dispatchToken ?? new Uint8Array(), TOKEN)).toBe(true);
      expect(decoded?.result).toBe(result);
    }
    expect(decodeSendAck(encodeFrame(Opcode.Send, textBytes(OP_ID)))).toBeNull();
  });

  it("rejects a send-ack frame with a wrong dispatch token length", () => {
    // encode: an 8-byte token is rejected
    expect(() => encodeSendAck(OP_ID, new Uint8Array(8), 0x00)).toThrow();
    // decode: the total length must be exactly 1 + 36 + 16 + 1 — one extra or missing byte (i.e. a
    // longer/shorter token field) is malformed
    const ack = encodeSendAck(OP_ID, TOKEN, 0x00);
    const long = new Uint8Array(ack.byteLength + 1);
    long.set(ack, 0);
    expect(decodeSendAck(long)).toBeNull();
    expect(decodeSendAck(ack.subarray(0, ack.byteLength - 1))).toBeNull();
  });
});
