import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");

describe("mobile account menu", () => {
  it("opens below the header account chip instead of beyond the top edge", () => {
    const tablet = css.slice(
      css.indexOf("@media (max-width: 900px)"),
      css.indexOf("@media (max-width: 640px)"),
    );
    const accountPopup = tablet.match(/\.account-pop\s*\{([^}]*)\}/u)?.[1] ?? "";

    expect(accountPopup).toContain("top: calc(100% + 8px)");
    expect(accountPopup).toContain("bottom: auto");
    expect(accountPopup).toContain("right: 0");
  });
});
