import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "worker/**/*.test.ts"],
    environment: "node",
  },
});
