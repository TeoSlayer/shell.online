import { describe, expect, it } from "vitest";
import { feedbackMessage } from "./mail";
import type { Feedback } from "./types";

const feedback: Feedback = {
  id: "fbk_1",
  uid: "uid-1",
  email: "ana@example.com",
  orgId: "org_1",
  kind: "problem",
  body: "The gate <b>never</b> opened & I gave up.",
  surface: "session-gate",
  route: "/sessions",
  appVersion: "0.15.1",
  userAgent: "Chrome 129 on macOS",
  canReply: false,
  context: { host: "laptop" },
  at: Date.UTC(2026, 8, 14, 12, 0, 0),
};

describe("feedbackMessage", () => {
  it("says what kind of message it is and where it came from", () => {
    const message = feedbackMessage(feedback, "team@example.com");
    expect(message.to).toBe("team@example.com");
    expect(message.subject).toBe("[shell.online feedback] Problem: The gate <b>never</b> opened & I gave up.");
    expect(message.text).toContain("session-gate on /sessions");
    expect(message.text).toContain("host: laptop");
    expect(message.text).toContain("asked not to be written to");
  });

  it("escapes what the sender typed before it is rendered as HTML", () => {
    const message = feedbackMessage(feedback, "team@example.com");
    expect(message.html).not.toContain("<b>never</b>");
    expect(message.html).toContain("&lt;b&gt;never&lt;/b&gt;");
    expect(message.html).toContain("&amp; I gave up.");
  });

  it("shortens a long first line in the subject", () => {
    const message = feedbackMessage({ ...feedback, body: `${"word ".repeat(30)}end` }, "team@example.com");
    expect(message.subject.length).toBeLessThan(110);
    expect(message.subject.endsWith("…")).toBe(true);
  });
});
