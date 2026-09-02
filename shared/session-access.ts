import { Opcode } from "./protocol";

export type ViewerFrameAction = "input" | "confirmed-eof" | "resize" | "ping" | "blocked-input" | "invalid";

export function viewerFrameAction(opcode: number, readOnly: boolean): ViewerFrameAction {
  if (opcode === Opcode.Input) return readOnly ? "blocked-input" : "input";
  if (opcode === Opcode.ConfirmedEOF) return readOnly ? "blocked-input" : "confirmed-eof";
  if (opcode === Opcode.Resize) return "resize";
  if (opcode === Opcode.Ping) return "ping";
  return "invalid";
}

export function readOnlyFromControlMessage(value: unknown): boolean | null {
  if (typeof value !== "object" || value === null) return null;
  const readOnly = (value as Record<string, unknown>).readOnly;
  return typeof readOnly === "boolean" ? readOnly : null;
}
