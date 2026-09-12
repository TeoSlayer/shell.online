import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");

describe("mobile account menu", () => {
  it("opens below the header account chip instead of beyond the top edge", () => {
    const mobileRule = css.match(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.account-pop\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(mobileRule).toMatch(/top:\s*calc\(100% \+ 8px\)/);
    expect(mobileRule).toMatch(/right:\s*0/);
    expect(mobileRule).toMatch(/bottom:\s*auto/);
  });
});
