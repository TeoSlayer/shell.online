import { describe, expect, it, vi } from "vitest";
import { PulseObserver } from "./pulse-observer";

const bytes = (s: string) => new TextEncoder().encode(s);
describe("passive viewer pulse lifecycle", () => {
  it("does not publish on connection alone, and snapshots aren't new output", () => {
    const emit = vi.fn(); const observer = new PulseObserver(emit);
    observer.connection(true); observer.tick(1000);
    expect(emit).not.toHaveBeenCalled();
    observer.feed(bytes("retained screen"), true, 1000); observer.tick(1000);
    expect(emit.mock.lastCall?.[0]).toMatchObject({activity:"unobserved",lastOutputAt:null,bytesSinceViewed:0});
  });
  it("coalesces output, counts only unseen live bytes, and acknowledges viewing", () => {
    const emit = vi.fn(); const observer = new PulseObserver(emit);
    observer.connection(true);
    observer.feed(bytes("abc"), false, 1000); observer.feed(bytes("def"), false, 1001);
    expect(emit).not.toHaveBeenCalled(); observer.tick(1002);
    expect(emit.mock.lastCall?.[0].bytesSinceViewed).toBe(6);
    observer.visibility(true); observer.tick(1003);
    expect(emit.mock.lastCall?.[0].bytesSinceViewed).toBe(0);
    observer.tick(20000); expect(emit.mock.lastCall?.[0].activity).toBe("quiet");
  });
  it.each(["disconnect", "host-away", "dispose"])("purges on %s and ignores queued output", (mode) => {
    const emit = vi.fn(); const observer = new PulseObserver(emit);
    observer.connection(true); observer.feed(bytes("Session too large to compact"), false, 1000); observer.tick(1000);
    if(mode === "disconnect") observer.connection(false);
    else if(mode === "host-away") observer.host(false);
    else observer.dispose();
    expect(emit.mock.lastCall?.[0]).toBeNull();
    const calls=emit.mock.calls.length;
    observer.feed(bytes("late private output"), false, 1001); observer.tick(1001);
    expect(emit).toHaveBeenCalledTimes(calls);
  });
  it("starts clean after reconnect and does not replay prior unread", () => {
    const emit = vi.fn(); const observer = new PulseObserver(emit);
    observer.connection(true); observer.feed(bytes("old"), false, 1000); observer.tick(1000);
    observer.connection(false); observer.connection(true);
    observer.feed(bytes("new snapshot"), true, 2000); observer.tick(2000);
    expect(emit.mock.lastCall?.[0]).toMatchObject({lastOutputAt:null,bytesSinceViewed:0});
  });
  it("purges on authorization loss and resumes from new output only on return", () => {
    const emit = vi.fn(); const observer = new PulseObserver(emit);
    observer.connection(true); observer.feed(bytes("private"), false, 1000); observer.tick(1000);
    observer.authorization(false);
    expect(emit.mock.lastCall?.[0]).toBeNull();
    observer.feed(bytes("unauthorized"), false, 2000); observer.tick(2000);
    expect(emit.mock.lastCall?.[0]).toBeNull();
    observer.authorization(true); observer.tick(3000);
    expect(emit.mock.lastCall?.[0]).toBeNull();
    observer.feed(bytes("new"), false, 3000); observer.tick(3000);
    expect(emit.mock.lastCall?.[0].bytesSinceViewed).toBe(3);
  });
});
