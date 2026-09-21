import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkshopMenu, type WorkshopMenuProps } from "./WorkshopMenu";

function render(overrides: Partial<WorkshopMenuProps> = {}) {
  const props: WorkshopMenuProps = {
    open: true,
    sessionCount: 0,
    tvMode: true,
    motion: "system",
    onClose: vi.fn(),
    onTeamOverview: vi.fn(),
    onBackToSessions: vi.fn(),
    onTvModeChange: vi.fn(),
    onMotionChange: vi.fn(),
    ...overrides,
  };
  return { html: renderToStaticMarkup(createElement(WorkshopMenu, props)), props };
}

describe("workshop menu", () => {
  it("uses a labelled native dialog with real controls and a clear exit", () => {
    const { html } = render();
    const headingId = html.match(/<h2 id="([^"]+)">Workshop menu<\/h2>/)?.[1];
    expect(headingId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${headingId}"`);
    expect(html).toMatch(/^<dialog\b/);
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:[\s=>])/);
    expect(html).toContain('type="button" autofocus="">Close menu</button>');
    expect(html).toContain('type="button">Back to sessions</button>');
    expect(html).toContain('aria-label="Shared-screen privacy"');
    expect(html).not.toMatch(/role="menuitem"|tabindex="-1"/);
  });

  it.each([
    [0, "No sessions in this view"],
    [1, "1 session in this view"],
    [24, "24 sessions in this view"],
  ])("shows the supplied session count (%s) without a demo roster", (sessionCount, countLabel) => {
    const { html } = render({ sessionCount });
    expect(html).toContain("Team overview");
    expect(html).toContain(countLabel);
  });

  it.each(["system", "full", "reduced"] as const)("reflects the caller's %s motion preference", (motion) => {
    const { html } = render({ motion });
    const motionId = html.match(/<select id="([^"]+)"/)?.[1];
    expect(motionId).toBeTruthy();
    expect(html).toContain(`for="${motionId}">Motion</label>`);
    expect(html).toContain(`<option value="${motion}" selected="">`);
    expect(html.match(/ selected=""/g)).toHaveLength(1);
  });

  it.each([true, false])("reflects TV mode %s without changing settings during render", (tvMode) => {
    const { html, props } = render({ tvMode });
    expect(html).toContain(`aria-pressed="${tvMode}"`);
    expect(props.onTvModeChange).not.toHaveBeenCalled();
    expect(props.onMotionChange).not.toHaveBeenCalled();
  });

  it("keeps private details hidden by default and explains the separate authorized reveal", () => {
    const { html, props } = render({ onHidePrivateDetails: vi.fn() });
    expect(html).toContain('role="status">Private details hidden</p>');
    expect(html).toContain("TV mode uses display aliases and operational status.");
    expect(html).toContain("Reveal private details separately in a session inspector, only when you have access.");
    expect(html).not.toContain(">Hide private details</button>");
    expect(html).not.toMatch(/<textarea|<input|Reveal private details<\/button>/);
    expect(props.onHidePrivateDetails).not.toHaveBeenCalled();
  });

  it("reports an existing private reveal and offers the caller's hide action", () => {
    const { html, props } = render({ privateDetailsVisible: true, onHidePrivateDetails: vi.fn() });
    expect(html).toContain('role="status">Private details visible</p>');
    expect(html).toContain('type="button">Hide private details</button>');
    expect(html).not.toContain('role="status">Private details hidden</p>');
    expect(props.onHidePrivateDetails).not.toHaveBeenCalled();
  });

  it("does not advertise an unavailable hide action", () => {
    const { html } = render({ privateDetailsVisible: true });
    expect(html).toContain("Private details visible");
    expect(html).not.toContain(">Hide private details</button>");
  });
});
