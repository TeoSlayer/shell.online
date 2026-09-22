import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("shared terminals use the app feedback path without transferring session data", () => {
  const source = readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
  const link = source.match(/<a\b[^>]*\bid="issue-open"[^>]*>/)?.[0];
  expect(link).toBeDefined();
  expect(link).toContain('href="https://app.shell.online/feedback?from=terminal"');
  expect(link).toContain('target="_blank"');
  expect(link).toContain('rel="noopener noreferrer"');
  expect(link).toContain('referrerpolicy="no-referrer"');
  expect(link).not.toContain("${");
  expect(link).not.toContain('aria-haspopup="dialog"');
  expect(source).not.toContain('id="issue-report"');
});
