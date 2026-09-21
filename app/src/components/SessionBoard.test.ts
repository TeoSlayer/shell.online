import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Member, SessionRecord } from "../lib/api";
import { SessionBoard } from "./SessionBoard";

/*
 * This test is about the card's summary markup, not about the vault: the
 * clipboard only asks the vault for an opener, and a card that is not opened
 * never calls it.
 */
vi.mock("../vault/VaultProvider", () => ({
  useVault: () => ({ openShare: async () => null }),
}));

const owner = { uid: "owner", role: "owner" } as Member;

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1",
  uid: "owner",
  orgId: "org",
  ownerUid: "owner",
  shareUrl: "https://example.invalid/s/s1",
  command: "htop",
  readOnly: false,
  encrypted: true,
  persistent: false,
  host: "laptop",
  startedAt: 1000,
  ...overrides,
} as SessionRecord);

const render = (overrides: Partial<SessionRecord> = {}) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SessionBoard, {
    liveWrite: [session(overrides)],
    liveRead: [],
    finished: [],
    now: 2000,
    members: [owner],
    you: owner,
    removing: "",
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    onAssign: vi.fn(),
    onStop: vi.fn(),
    stopping: "",
  })));

describe("board card summaries", () => {
  it("shows the genuine description when the record carries one", () => {
    const html = render({ description: "Runs the nightly import and reports failures." });
    expect(html).toContain("Runs the nightly import and reports failures.");
    expect(html).not.toContain("No description.");
  });

  it("shows the truthful empty state when there is no description", () => {
    const html = render();
    expect(html).toContain('<p class="board-card-summary">No description.</p>');
  });
});
