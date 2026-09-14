import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { BROWSER_SECURITY_HEADERS } from "./server/lib/browser-headers.ts";

/*
 * Cross-Origin-Opener-Policy: signInWithPopup polls window.closed on the
 * Google window. Under the default COOP the browser severs that handle and
 * logs "Cross-Origin-Opener-Policy policy would block the window.closed
 * call", so the popup never resolves cleanly. same-origin-allow-popups keeps
 * the isolation while letting the opener keep its handle.
 *
 * Whatever serves the production build must send the same header.
 */
const authHeaders = BROWSER_SECURITY_HEADERS;

/*
 * The product version, from the repository's package.json rather than this
 * package's, which is 0.0.0 on purpose. Stamped into the bundle so a piece of
 * feedback can say which build it came from; the commit is added when the
 * build runs somewhere that knows it.
 */
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const commit = process.env.GITHUB_SHA?.slice(0, 7);
const appVersion = commit ? `${version}+${commit}` : version;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  /*
   * Blank is absent, not a value. `??` only catches undefined, and a
   * workflow that passes an unset repository variable through supplies the
   * empty string, so this config took `new URL("")` and the whole build died
   * on `TypeError: Invalid URL` with no clue which variable was at fault.
   */
  const relay = env.VITE_RELAY_URL?.trim() || "http://127.0.0.1:8788";
  let relayOrigin: string;
  try {
    relayOrigin = new URL(relay).origin;
  } catch {
    throw new Error(`VITE_RELAY_URL is not a URL: ${JSON.stringify(env.VITE_RELAY_URL)}`);
  }

  return {
    plugins: [react()],
    define: { __SHELL_ONLINE_VERSION__: JSON.stringify(appVersion) },
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
