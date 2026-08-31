import { describe, expect, it } from "vitest";
import { chooseResizeOwner } from "../shared/resize-control";

describe("shared PTY resize ownership", () => {
  const now = 10_000;

  it("keeps one stable owner instead of letting viewers fight", () => {
    const viewers = [
      { id: 20, guestNumber: 2, connected: true },
      { id: 10, guestNumber: 1, connected: true },
    ];
    expect(chooseResizeOwner(viewers, null, now, 1_800)).toBe(10);
    expect(chooseResizeOwner(viewers, 20, now, 1_800)).toBe(20);
  });

  it("hands sizing to the active collaborator and ignores disconnected viewers", () => {
    const viewers = [
      { id: 1, guestNumber: 1, connected: true },
      { id: 2, guestNumber: 2, connected: true, typingAt: now - 10 },
      { id: 3, guestNumber: 3, connected: false, typingAt: now },
    ];
    expect(chooseResizeOwner(viewers, 1, now, 1_800)).toBe(2);
  });
});
