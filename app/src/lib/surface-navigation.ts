const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='option']",
  "[role='menuitem']",
  "[contenteditable='true']",
].join(",");

type ClosestTarget = EventTarget & {
  closest(selector: string): Element | null;
};

function supportsClosest(target: EventTarget | null): target is ClosestTarget {
  return Boolean(target && typeof (target as Partial<ClosestTarget>).closest === "function");
}

/**
 * Lets an otherwise inert part of a row/card open its session without stealing
 * a click from a control inside that surface.
 */
export function shouldOpenSurface(target: EventTarget | null, defaultPrevented = false): boolean {
  if (defaultPrevented) return false;
  return !supportsClosest(target) || !target.closest(INTERACTIVE_SELECTOR);
}
