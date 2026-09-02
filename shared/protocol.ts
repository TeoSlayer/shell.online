export const enum Opcode {
  Output = 0x01,
  Input = 0x02,
  Snapshot = 0x03,
  Resize = 0x04,
  FinalSnapshot = 0x05,
  Ping = 0x06,
  Pong = 0x07,
  BroadcastSnapshot = 0x08,
  ConfirmedEOF = 0x09,
}

export const MAX_INPUT_CHUNK = 16 * 1024;

export function encodeFrame(opcode: Opcode, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = opcode;
  frame.set(payload, 1);
  return frame;
}

export function encodeResize(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5);
  const view = new DataView(frame.buffer);
  frame[0] = Opcode.Resize;
  view.setUint16(1, cols);
  view.setUint16(3, rows);
  return frame;
}

export function encodeLatencyProbe(token: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5);
  frame[0] = Opcode.Ping;
  new DataView(frame.buffer).setUint32(1, token);
  return frame;
}

export function decodeLatencyProbe(frame: Uint8Array): number | null {
  if (frame.byteLength !== 5 || frame[0] !== Opcode.Pong) return null;
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
}

export function decodeResize(frame: Uint8Array): { cols: number; rows: number } | null {
  if (frame.byteLength !== 5 || frame[0] !== Opcode.Resize) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { cols: view.getUint16(1), rows: view.getUint16(3) };
}
