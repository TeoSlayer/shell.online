/*
 * Vendored verbatim from shell.online: shared/protocol.ts
 *
 * This is the wire format the relay and the CLI already speak. It is copied
 * rather than reimplemented so the two cannot drift apart in meaning, and
 * checked by `npm run check:protocol`, which fails if the upstream file
 * changes. Do not edit here; edit upstream and re-sync.
 */
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
  /** Encrypted, relay-targeted request from one viewer to the CLI file service. */
  FileRequest = 0x0a,
  /** Encrypted, relay-targeted response from the CLI file service to one viewer. */
  FileResponse = 0x0b,
  // DO->host control frame carrying one atomic shell_send operation (operation id, enter flag,
  // 16-byte dispatch token, text). The host writes text (+ a single \r when enter) in one write
  // and acks with SendAck, echoing the dispatch token verbatim.
  Send = 0x0c,
  // host->DO acknowledgement for a Send frame, echoing the operation id, the dispatch token, and
  // a result code.
  SendAck = 0x0d,
}

export const MAX_INPUT_CHUNK = 16 * 1024;

export function isSnapshotOpcode(opcode: number): boolean {
  return opcode === Opcode.Snapshot ||
    opcode === Opcode.FinalSnapshot ||
    opcode === Opcode.BroadcastSnapshot;
}

// shell_send wire constants (must stay in sync with internal/protocol).
export const SEND_OPERATION_ID_BYTES = 36; // a UUID v4 is 36 ASCII bytes
export const SEND_DISPATCH_TOKEN_BYTES = 16; // per-dispatch random nonce; the host echoes it verbatim
export const SEND_MAX_TEXT_BYTES = 8192;
export const SEND_RESULT_DELIVERED = 0x00; // the complete operation reached the PTY
export const SEND_RESULT_UNCERTAIN = 0x01; // the write was partial/interrupted; not confirmed

const opIdEncoder = new TextEncoder();
const opIdDecoder = new TextDecoder();

// [Send][operationId:36][enter:1][dispatchToken:16][text:N]
export function encodeSend(
  operationId: string,
  enter: boolean,
  dispatchToken: Uint8Array,
  text: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (dispatchToken.byteLength !== SEND_DISPATCH_TOKEN_BYTES) {
    throw new Error(`dispatchToken must be ${SEND_DISPATCH_TOKEN_BYTES} bytes`);
  }
  const opId = opIdEncoder.encode(operationId);
  const payload = new Uint8Array(opId.byteLength + 1 + SEND_DISPATCH_TOKEN_BYTES + text.byteLength);
  payload.set(opId, 0);
  payload[opId.byteLength] = enter ? 1 : 0;
  payload.set(dispatchToken, opId.byteLength + 1);
  payload.set(text, opId.byteLength + 1 + SEND_DISPATCH_TOKEN_BYTES);
  return encodeFrame(Opcode.Send, payload);
}

export function decodeSend(
  frame: Uint8Array,
): { operationId: string; enter: boolean; dispatchToken: Uint8Array; text: Uint8Array } | null {
  if (frame.byteLength < 1 + SEND_OPERATION_ID_BYTES + 1 + SEND_DISPATCH_TOKEN_BYTES + 1 || frame[0] !== Opcode.Send)
    return null;
  const payload = frame.subarray(1);
  const operationId = opIdDecoder.decode(payload.subarray(0, SEND_OPERATION_ID_BYTES));
  const enter = payload[SEND_OPERATION_ID_BYTES] === 1;
  const dispatchToken = payload.subarray(SEND_OPERATION_ID_BYTES + 1, SEND_OPERATION_ID_BYTES + 1 + SEND_DISPATCH_TOKEN_BYTES);
  const text = payload.subarray(SEND_OPERATION_ID_BYTES + 1 + SEND_DISPATCH_TOKEN_BYTES);
  if (text.byteLength < 1 || text.byteLength > SEND_MAX_TEXT_BYTES) return null;
  return { operationId, enter, dispatchToken, text };
}

// [SendAck][operationId:36][dispatchToken:16][result:1]
export function encodeSendAck(operationId: string, dispatchToken: Uint8Array, result: number): Uint8Array<ArrayBuffer> {
  if (dispatchToken.byteLength !== SEND_DISPATCH_TOKEN_BYTES) {
    throw new Error(`dispatchToken must be ${SEND_DISPATCH_TOKEN_BYTES} bytes`);
  }
  const opId = opIdEncoder.encode(operationId);
  const payload = new Uint8Array(opId.byteLength + SEND_DISPATCH_TOKEN_BYTES + 1);
  payload.set(opId, 0);
  payload.set(dispatchToken, opId.byteLength);
  payload[opId.byteLength + SEND_DISPATCH_TOKEN_BYTES] = result;
  return encodeFrame(Opcode.SendAck, payload);
}

export function decodeSendAck(
  frame: Uint8Array,
): { operationId: string; dispatchToken: Uint8Array; result: number } | null {
  if (frame.byteLength !== 1 + SEND_OPERATION_ID_BYTES + SEND_DISPATCH_TOKEN_BYTES + 1 || frame[0] !== Opcode.SendAck)
    return null;
  const payload = frame.subarray(1);
  return {
    operationId: opIdDecoder.decode(payload.subarray(0, SEND_OPERATION_ID_BYTES)),
    dispatchToken: payload.subarray(SEND_OPERATION_ID_BYTES, SEND_OPERATION_ID_BYTES + SEND_DISPATCH_TOKEN_BYTES),
    result: payload[SEND_OPERATION_ID_BYTES + SEND_DISPATCH_TOKEN_BYTES],
  };
}

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
