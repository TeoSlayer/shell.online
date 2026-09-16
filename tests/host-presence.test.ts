import { describe, expect, it } from "vitest";
import { describeSince, hostIsAway, hostNotice } from "../shared/host-presence";

const NOW = Date.parse("2026-09-15T20:00:00.000Z");

describe("hostIsAway", () => {
  it("is true only while the machine is not there and the session lives on", () => {
    expect(hostIsAway("disconnected")).toBe(true);
    expect(hostIsAway("waiting")).toBe(true);
    expect(hostIsAway("connected")).toBe(false);
    /* An ended session has its own notice; this one would contradict it. */
    expect(hostIsAway("exited")).toBe(false);
    expect(hostIsAway(undefined)).toBe(false);
  });
});

describe("describeSince", () => {
  it("counts in the unit a person would use", () => {
    expect(describeSince(NOW, "2026-09-15T19:59:40.000Z")).toBe("just now");
    expect(describeSince(NOW, "2026-09-15T19:59:00.000Z")).toBe("1 minute ago");
    expect(describeSince(NOW, "2026-09-15T19:40:00.000Z")).toBe("20 minutes ago");
    expect(describeSince(NOW, "2026-09-15T17:00:00.000Z")).toBe("3 hours ago");
    expect(describeSince(NOW, "2026-09-13T20:00:00.000Z")).toBe("2 days ago");
  });

  it("says nothing rather than inventing a moment", () => {
    expect(describeSince(NOW, undefined)).toBeUndefined();
    expect(describeSince(NOW, "not a date")).toBeUndefined();
  });

  /* A clock that is behind the relay's must not produce "in 3 minutes". */
  it("never counts forwards", () => {
    expect(describeSince(NOW, "2026-09-15T20:05:00.000Z")).toBe("just now");
  });
});

describe("hostNotice", () => {
  it("says nothing while the machine is connected", () => {
    expect(hostNotice({ status: "connected", hasScreen: true, now: NOW })).toBeNull();
  });

  it("explains an empty terminal whose machine went away", () => {
    const notice = hostNotice({
      status: "disconnected",
      hostLastSeenAt: "2026-09-15T18:00:00.000Z",
      hasScreen: false,
      now: NOW,
    });
    expect(notice?.heading).toBe("Temporarily offline");
    expect(notice?.body).toContain("went offline 2 hours ago");
    expect(notice?.body).toContain("comes back on its own");
    expect(notice?.showingKeptScreen).toBe(false);
  });

  it("marks a kept screen as kept, and dates it", () => {
    const notice = hostNotice({
      status: "disconnected",
      hostLastSeenAt: "2026-09-15T19:30:00.000Z",
      screenCapturedAt: "2026-09-15T19:25:00.000Z",
      hasScreen: true,
      now: NOW,
    });
    expect(notice?.showingKeptScreen).toBe(true);
    expect(notice?.body).toContain("last screen it sent, from 35 minutes ago");
  });

  it("does not claim a machine went offline when it was never on", () => {
    const notice = hostNotice({ status: "waiting", hasScreen: false, now: NOW });
    expect(notice?.heading).toBe("Waiting for this machine");
    expect(notice?.body).not.toContain("offline");
  });

  /* An older relay sends no timestamp; the notice still has to make sense. */
  it("works without a last-seen time", () => {
    const notice = hostNotice({ status: "disconnected", hasScreen: false, now: NOW });
    expect(notice?.body).toContain("is not connected right now");
    expect(notice?.body).not.toContain("undefined");
  });
});
