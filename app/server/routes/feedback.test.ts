import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../lib/store-memory";
import type { Membership } from "../lib/orgs";
import type { Message } from "../lib/mail";
import { MAX_FEEDBACK, readFeedback, submitFeedback } from "./feedback";

const ana: Membership = {
  orgId: "org_1",
  uid: "uid-1",
  email: "ana@example.com",
  name: "Ana",
  role: "owner",
  joinedAt: 1000,
};

const valid = {
  kind: "idea",
  body: "  Let me pin a session.  ",
  surface: "account-menu",
  route: "/account?tab=vault#nope",
  app_version: "0.15.1",
  can_reply: true,
  context: { host: "laptop", count: 3, "Bad Key": "x", empty: "   " },
};

function mailbox() {
  const sent: Message[] = [];
  return { sent, mailer: { send: async (message: Message) => void sent.push(message) } };
}

describe("readFeedback", () => {
  it("keeps the message and the place it came from, and nothing else", () => {
    const read = readFeedback(valid);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({
      kind: "idea",
      body: "Let me pin a session.",
      surface: "account-menu",
      route: "/account",
      appVersion: "0.15.1",
      canReply: true,
      context: { host: "laptop" },
    });
  });

  it("needs a kind it knows", () => {
    const read = readFeedback({ ...valid, kind: "rant" });
    expect(read).toMatchObject({ ok: false, status: 400 });
  });

  it("needs something written", () => {
    const read = readFeedback({ ...valid, body: "   " });
    expect(read).toMatchObject({ ok: false, status: 400, error: "write something first" });
  });

  it("caps the length", () => {
    const read = readFeedback({ ...valid, body: "x".repeat(MAX_FEEDBACK + 1) });
    expect(read).toMatchObject({ ok: false, status: 400 });
    expect(readFeedback({ ...valid, body: "x".repeat(MAX_FEEDBACK) }).ok).toBe(true);
  });

  it("keeps the attached facts small", () => {
    const context: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) context[`key_${index}`] = "v".repeat(500);
    const read = readFeedback({ ...valid, context });
    if (!read.ok) throw new Error("expected ok");
    expect(Object.keys(read.value.context)).toHaveLength(8);
    expect(read.value.context.key_0).toHaveLength(200);
  });

  it("names an unknown surface rather than trusting one", () => {
    const read = readFeedback({ ...valid, surface: "Weird Surface!" });
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.surface).toBe("unknown");
  });

  it("treats a missing reply choice as no", () => {
    const read = readFeedback({ ...valid, can_reply: "yes" });
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.canReply).toBe(false);
  });
});

describe("submitFeedback", () => {
  it("stores and forwards anonymous reports without invented identity or reply permission", async () => {
    const store = MemoryStore.memory();
    const { sent, mailer } = mailbox();
    const result = await submitFeedback(store, mailer, null, { ...valid, email: "forged@example.com", uid: "forged" }, "", "team@example.com", vi.fn(), 5000);
    expect(result.ok).toBe(true);
    expect(await store.feedback()).toEqual([expect.objectContaining({ uid: "", email: "", orgId: undefined, canReply: false, context: {} })]);
    expect(JSON.stringify(sent)).toContain("anonymous visitor");
    expect(JSON.stringify(sent)).not.toContain("forged");
  });
  it("stores the message and forwards it when an address is set", async () => {
    const store = MemoryStore.memory();
    const { sent, mailer } = mailbox();
    const log = vi.fn();
    const result = await submitFeedback(store, mailer, ana, valid, "Mozilla/5.0 Chrome/129", "team@example.com", log, 5000);
    expect(result.ok).toBe(true);
    const [kept] = await store.feedback();
    expect(kept).toMatchObject({
      uid: "uid-1",
      email: "ana@example.com",
      orgId: "org_1",
      kind: "idea",
      body: "Let me pin a session.",
      surface: "account-menu",
      route: "/account",
      userAgent: "Mozilla/5.0 Chrome/129",
      canReply: true,
      context: { host: "laptop" },
      at: 5000,
    });
    expect(kept.id).toMatch(/^fbk_/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("team@example.com");
    expect(sent[0].subject).toContain("Idea");
    expect(sent[0].text).toContain("ana@example.com");
    expect(sent[0].text).toContain("fine to reply");
    expect(log).not.toHaveBeenCalled();
  });

  it("stores without forwarding when no address is set", async () => {
    const store = MemoryStore.memory();
    const { sent, mailer } = mailbox();
    await submitFeedback(store, mailer, ana, valid, "", undefined, vi.fn());
    expect(await store.feedback()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("keeps the message when the mail provider fails", async () => {
    const store = MemoryStore.memory();
    const log = vi.fn();
    const mailer = { send: async () => { throw new Error("sendgrid returned 401"); } };
    const result = await submitFeedback(store, mailer, ana, valid, "", "team@example.com", log);
    expect(result.ok).toBe(true);
    expect(await store.feedback()).toHaveLength(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it("refuses what it cannot read without writing anything", async () => {
    const store = MemoryStore.memory();
    const result = await submitFeedback(store, mailbox().mailer, ana, { kind: "idea", body: "" }, "", undefined, vi.fn());
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await store.feedback()).toEqual([]);
  });
});
