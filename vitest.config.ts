import { defineConfig } from "vitest/config";

/*
 * The platform app under app/ is its own package with its own dependencies and
 * its own vitest config, and it is run by `npm run test:app`. Without this it
 * would be swept into the root run, which passes here only because app's
 * dependencies happen to be installed -- on a fresh clone that installed only
 * the root ones, every one of its files would fail to resolve an import.
 *
 * .claude/ is excluded for a related reason. A git worktree created inside
 * the repository puts a second copy of every test under it, and those copies
 * run with the wrong working directory: a test that reads a source file by
 * path fails on a file that is present, in a checkout nobody is working on.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "app/**", "**/.claude/**"],
  },
});
