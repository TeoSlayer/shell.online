import { describe, expect, it } from "vitest";
import {
  isSessionFullClose,
  MAX_SESSION_VIEWERS,
  SESSION_FULL_CLOSE_CODE,
  SESSION_FULL_CLOSE_REASON,
  viewerAdmission,
} from "../shared/session-capacity";

describe("session viewer capacity", () => {
  it("admits viewers until all slots are occupied", () => {
    expect(viewerAdmission(MAX_SESSION_VIEWERS - 1)).toEqual({ accepted: true });
  });

  it("turns a full session into a browser-visible WebSocket close", () => {
    expect(viewerAdmission(MAX_SESSION_VIEWERS)).toEqual({
      accepted: false,
      closeCode: SESSION_FULL_CLOSE_CODE,
      reason: SESSION_FULL_CLOSE_REASON,
    });
    expect(viewerAdmission(MAX_SESSION_VIEWERS + 1).accepted).toBe(false);
    expect(isSessionFullClose(SESSION_FULL_CLOSE_CODE)).toBe(true);
    expect(isSessionFullClose(4000)).toBe(false);
    expect(isSessionFullClose(4004)).toBe(false);
  });
});
