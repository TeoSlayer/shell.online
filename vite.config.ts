import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        docs: resolve(import.meta.dirname, "docs/index.html"),
        mobile: resolve(import.meta.dirname, "mobile/index.html"),
        reliability: resolve(import.meta.dirname, "reliability/index.html"),
        security: resolve(import.meta.dirname, "security/index.html"),
      },
    },
  },
});
