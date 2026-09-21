import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Member, SessionRecord } from "../lib/api";
import { SessionAutomation } from "./SessionAutomation";

const session = { id: "session", ownerUid: "owner" } as SessionRecord;
const render = (uid: string, role: Member["role"] = "member", changes: Partial<SessionRecord> = {}) => {
  const onChange = vi.fn();
  const html = renderToStaticMarkup(createElement(SessionAutomation, {
    session: { ...session, ...changes }, you: { uid, role } as Member, onChange,
  }));
  return { html, onChange };
};

describe("session automation controls", () => {
  it("renders three unchecked permissions and honest readiness copy", () => {
    const { html, onChange } = render("owner");
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).not.toContain("checked=");
    expect(html).toContain("No new prompt or model call");
    expect(html).toContain("owner-only");
    expect(html).toContain("updated compatible host");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("does not turn team MCP permission into briefing permission", () => {
    expect(render("owner", "member", { mcpTeamAccess: true }).html.match(/checked=""/g)).toHaveLength(1);
  });
  it.each(["member", "admin", "owner"] as const)("does not show controls to a non-owning org %s", (role) => {
    expect(render("other", role).html).toBe("");
  });
});
