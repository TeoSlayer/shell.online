import { defineConfig } from "vitest/config";

/*
 * The platform app under app/ is its own package with its own dependencies and
 * its own vitest config, and it is run by `npm run test:app`. Without this it
 * would be swept into the root run, which passes here only because app's
 * dependencies happen to be installed -- on a fresh clone that installed only
 * the root ones, every one of its files would fail to resolve an import.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "app/**"],
  },
});
