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
        cli: resolve(import.meta.dirname, "cli/index.html"),
        mobile: resolve(import.meta.dirname, "mobile/index.html"),
        reliability: resolve(import.meta.dirname, "reliability/index.html"),
        security: resolve(import.meta.dirname, "security/index.html"),
        e2ee: resolve(import.meta.dirname, "e2ee/index.html"),
        docker: resolve(import.meta.dirname, "docker/index.html"),
      },
    },
  },
});
