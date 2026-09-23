import type { KeyboardEvent } from "react";

/** Native controls in DOM order, excluding disabled, hidden and roving items. */
export function dialogControls(element: HTMLElement | null): HTMLElement[] {
  if (!element) return [];
  return [...element.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
    .filter((control) => control.tabIndex >= 0 && !control.matches(":disabled") &&
      control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden");
}

/** Keep Tab in the topmost dialog, including a menu with only one roving tab stop. */
export function trapDialogTab(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  if (event.target instanceof Element && event.target.closest("dialog") !== dialog) return;
  const controls = dialogControls(dialog);
  const stops = controls.filter((control) => {
    if (!(control instanceof HTMLInputElement) || control.type !== "radio" || !control.name) return true;
    const checked = controls.find((other) => other instanceof HTMLInputElement &&
      other.type === "radio" && other.name === control.name && other.form === control.form && other.checked);
    return !checked || checked === control;
  });
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
