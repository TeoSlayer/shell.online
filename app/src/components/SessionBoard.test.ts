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
    expect(html).toContain('<div class="board-card-summary">No description.</div>');
  });
});

describe("board card actions", () => {
  /*
   * The board and the table offer the same two controls, and they were not in
   * the same order or in the same place: the foot laid out the assignee, the
   * stop and the open as three separate children of a space-between row, so a
   * card read left to right as "Sam, Stop, Open" while its row read "Open,
   * Stop". The pair now travels as one group, the way the table's last column
   * carries it.
   */
  it("groups open and stop together, open first, the way the table does", () => {
    const html = render({ deviceId: "device-1" });
    const foot = html.slice(html.indexOf('class="board-card-foot"'));
    const group = foot.slice(foot.indexOf('class="session-actions"'));
    expect(group).toContain("Open");
    expect(group).toContain("Stop");
    expect(group.indexOf("Open")).toBeLessThan(group.indexOf("Stop"));
  });

  it("keeps the stop button inside the group rather than loose in the foot", () => {
    const html = render({ deviceId: "device-1" });
    const foot = html.slice(html.indexOf('class="board-card-foot"'));
    expect(foot.indexOf('class="session-actions"')).toBeLessThan(foot.indexOf("Stop"));
  });
});

describe("the finished column", () => {
  /* A column heading is not the place to enumerate every way a run can end. */
  it("says what happened in one phrase", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SessionBoard, {
      liveWrite: [],
      liveRead: [],
      finished: [session({ closedAt: 1500 })],
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
    expect(html).toContain("Process has exited");
    expect(html).not.toContain("stopped answering");
  });
});
