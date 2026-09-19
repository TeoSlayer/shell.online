import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { browserSecurityHeaders } from "./server/lib/browser-headers.ts";

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
  const oidcValues = [env.VITE_OIDC_ISSUER, env.VITE_OIDC_CLIENT_ID];
  const firebaseValues = [
    env.VITE_FIREBASE_API_KEY,
    env.VITE_FIREBASE_AUTH_DOMAIN,
    env.VITE_FIREBASE_PROJECT_ID,
    env.VITE_FIREBASE_APP_ID,
  ];
  const complete = (values: Array<string | undefined>) => values.every((value) => value?.trim());
  const partial = (values: Array<string | undefined>) => values.some((value) => value?.trim()) && !complete(values);
  if (partial(oidcValues)) {
    throw new Error("Set both VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID, or neither.");
  }
  if (partial(firebaseValues)) {
    throw new Error("Set the complete VITE_FIREBASE_* client configuration, or none of it.");
  }
  if (mode === "production" && !complete(oidcValues) && !complete(firebaseValues)) {
    throw new Error("Configure either OpenID Connect or Firebase before a production build.");
  }
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

  /*
   * The dev and preview servers send the same policy the production servers
   * do, built around the same provider, so a sign-in that the policy would
   * block fails here rather than only after a deploy. Whatever serves the
   * production build must send these headers too.
   */
  const authHeaders = browserSecurityHeaders(env.VITE_OIDC_ISSUER?.trim());

  /*
   * The dev server needs one relaxation the others must not have.
   *
   * @vitejs/plugin-react injects its Fast Refresh preamble as an inline
   * <script type="module"> into every page it serves. Under script-src 'self'
   * the browser refuses to run it, and because that preamble runs before
   * main.tsx, the refusal takes the whole application with it: `npm run dev`
   * served a blank page and one CSP error, on every route.
   *
   * So the dev server, and only the dev server, also allows inline scripts.
   * `preview` keeps the strict policy, and preview is the one that matters for
   * the guarantee above: it serves the real production build, which has no
   * inline script in it, so a policy problem that would break a deployment
   * still surfaces before the deployment.
   */
  const devHeaders = {
    ...authHeaders,
    "Content-Security-Policy": authHeaders["Content-Security-Policy"].replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-inline'",
    ),
  };

  return {
    plugins: [react()],
    define: { __SHELL_ONLINE_VERSION__: JSON.stringify(appVersion) },
    /*
     * The game skin is deliberately NOT given a manualChunks entry.
     *
     * Naming it as a manual chunk looks tidier and is a trap: Vite treats a
     * manual chunk as part of the initial graph, so index.html came back with
     * a `modulepreload` for the game and a `<link rel="stylesheet">` for its
     * stylesheet. Every visitor then downloaded the keep on their way to the
     * session list, which is the exact thing the lazy import exists to
     * prevent. `npm run verify:bundle` is what caught it and what will catch
     * it again.
     *
     * Left alone, the dynamic import in src/App.tsx produces a true async
     * chunk that is fetched when somebody asks for the game and not before.
     */
    server: {
      headers: devHeaders,
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
