import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/*
 * Cross-Origin-Opener-Policy: signInWithPopup polls window.closed on the
 * Google window. Under the default COOP the browser severs that handle and
 * logs "Cross-Origin-Opener-Policy policy would block the window.closed
 * call", so the popup never resolves cleanly. same-origin-allow-popups keeps
 * the isolation while letting the opener keep its handle.
 *
 * Whatever serves the production build must send the same header.
 */
const authHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const relay = env.VITE_RELAY_URL ?? "http://127.0.0.1:8788";
  const relayOrigin = new URL(relay).origin;

  return {
    plugins: [react()],
    server: {
      headers: authHeaders,
      /*
       * The relay refuses a WebSocket whose Origin is not its own
       * (worker/index.ts, "origin not allowed"). In production the app is
       * served from the relay's origin so the question does not arise. In
       * development they are separate ports, so /relay is proxied and the
       * Origin is rewritten to the relay's own, which is what a same-origin
       * browser would have sent anyway.
       */
      proxy: {
        "/relay": {
          target: relay,
          ws: true,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/relay/, ""),
          configure(proxy: {
            on(event: string, handler: (request: { setHeader(name: string, value: string): void }) => void): void;
          }) {
            const setOrigin = (request: { setHeader(name: string, value: string): void }) => {
              request.setHeader("origin", relayOrigin);
            };
            proxy.on("proxyReq", setOrigin);
            proxy.on("proxyReqWs", setOrigin);
          },
        },
      },
    },
    preview: { headers: authHeaders },
  };
});
