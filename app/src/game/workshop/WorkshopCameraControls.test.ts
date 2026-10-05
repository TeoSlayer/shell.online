import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkshopCameraControls, type WorkshopCameraControlsProps } from "./WorkshopCameraControls";

function render(overrides: Partial<WorkshopCameraControlsProps> = {}) {
  const props: WorkshopCameraControlsProps = {
    zoom: 1.2345,
    minZoom: 0.5,
    maxZoom: 2,
    myAreaState: "available",
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFitTeam: vi.fn(),
    onFocusMyArea: vi.fn(),
    onResetView: vi.fn(),
    panHint: "Drag the map to pan.",
    ...overrides,
  };
  return { html: renderToStaticMarkup(createElement(WorkshopCameraControls, props)), props };
}

function disabled(html: string, label: string): boolean {
  const opening = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  expect(opening).toBeTruthy();
  return opening!.includes("disabled");
}

describe("workshop camera controls", () => {
  it.each([
    [0.5, true, false],
    [0.5000000001, false, false],
    [1.2345, false, false],
    [1.9999999999, false, false],
    [2, false, true],
  ])("uses actual supplied zoom %s for its bounds", (zoom, out, into) => {
    const { html } = render({ zoom });
    expect(disabled(html, "Zoom out")).toBe(out);
    expect(disabled(html, "Zoom in")).toBe(into);
    expect(html).toContain(`data-zoom="${zoom}"`);
    expect(html).toContain(`${zoom}×</output>`);
  });

  it("supports a fixed scale while leaving fit/reset available", () => {
    const { html } = render({ zoom: 1, minZoom: 1, maxZoom: 1 });
    expect(disabled(html, "Zoom out")).toBe(true);
    expect(disabled(html, "Zoom in")).toBe(true);
    expect(html).toContain('<button type="button">Fit team</button>');
    expect(html).toContain('<button type="button">Reset view</button>');
  });

  it.each([
    { zoom: NaN }, { zoom: Infinity }, { zoom: 0 },
    { minZoom: 0 }, { maxZoom: NaN }, { minZoom: 3, maxZoom: 2 },
  ])("does not offer zoom actions with unavailable/invalid limits: %o", (values) => {
    const { html } = render(values);
    expect(disabled(html, "Zoom out")).toBe(true);
    expect(disabled(html, "Zoom in")).toBe(true);
  });

  it.each([
    ["unknown", "Your area is not known yet."],
    ["unassigned", "No area is assigned to you."],
  ] as const)("disables personal focus when the area is %s", (myAreaState, explanation) => {
    const { html } = render({ myAreaState });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Focus my area<\/button>/);
    expect(html).toContain(explanation);
  });

  it("shows the supplied pan hint without adding shortcuts or camera state", () => {
    const { html, props } = render();
    expect(html).toContain('role="group" aria-label="Map camera controls"');
    expect(html).toContain("Drag the map to pan.");
    expect(html).toContain('<button type="button">Focus my area</button>');
    expect(html).not.toMatch(/autofocus|tabindex|Minimap/);
    expect(props.onFitTeam).not.toHaveBeenCalled();
    expect(props.onZoomIn).not.toHaveBeenCalled();
  });

  it.each([true, false])("shows minimap state %s only when its callback is supplied", (visible) => {
    const { html } = render({ minimap: { visible, onVisibleChange: vi.fn() } });
    expect(html).toContain(`<button type="button" aria-pressed="${visible}">Minimap</button>`);
  });
});
