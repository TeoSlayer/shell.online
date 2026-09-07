import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves the built client, so the app and its API share an origin.
 *
 * That is not a convenience. The relay refuses a websocket whose Origin is not
 * its own, and the browser decides the Origin from where the page came. Serving
 * the app from the service that proxies the relay is what lets a terminal
 * connect at all; see relay-proxy.ts for the other half.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/*
 * Cross-Origin-Opener-Policy: signInWithPopup polls window.closed on the
 * Google window, and the default policy severs that handle so the popup never
 * resolves. same-origin-allow-popups keeps the isolation and the handle. The
 * dev server sends the same header; this is the production half of it.
 */
const DOCUMENT_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface StaticFiles {
  (request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/**
 * @param root directory holding the built client, as `vite build` leaves it.
 */
export function staticFiles(root: string): StaticFiles {
  const rootPath = resolve(root);
  /*
   * The root is resolved through its own symlinks once, because comparing a
   * file's real path against a root that is itself a link would reject
   * everything -- /var is a link to /private/var on macOS, and a container
   * bind mount can be a link anywhere.
   */
  let realRoot: Promise<string> | null = null;
  const rootReal = () => (realRoot ??= realpath(rootPath).catch(() => rootPath));

  async function fileFor(pathname: string): Promise<string | null> {
    /*
     * decodeURIComponent so a real filename with a space is found, then a
     * resolve-and-compare rather than a scan for "..": the check has to be on
     * where the path lands, not on how it was spelled, or %2e%2e walks out.
     */
    let requested: string;
    try {
      requested = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (requested.includes("\0")) return null;

    const candidate = resolve(join(rootPath, requested));
    if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) return null;

    try {
      const found = await stat(candidate);
      if (found.isDirectory()) return fileFor(join(requested, "index.html"));
      /* A symlink could still point outside; the real path is what is served. */
      const real = await realpath(candidate);
      const base = await rootReal();
      if (real !== base && !real.startsWith(base + sep)) return null;
      return real;
    } catch {
      return null;
    }
  }

  return async function serve(request, response) {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    /*
     * A path that misses falls back to the app shell, because the router owns
     * these URLs -- /sessions/abc is a page, not a file. A path that looks
     * like an asset does not: answering a missing script with HTML turns a bad
     * deploy into a parse error somewhere unrelated.
     */
    let file = await fileFor(pathname);
    const isAsset = extname(pathname) !== "";
    if (!file && !isAsset) file = await fileFor("/index.html");
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const extension = extname(file);
    const found = await stat(file);
    /*
     * Vite fingerprints what it puts in assets/, so those may be cached
     * forever. Everything else, the entry document above all, must be
     * revalidated or a deploy would not reach anyone still holding a tab open.
     */
    const immutable = pathname.startsWith("/assets/") && extension !== ".html";

    response.writeHead(200, {
      "Content-Type": TYPES[extension] ?? "application/octet-stream",
      "Content-Length": found.size,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "Last-Modified": found.mtime.toUTCString(),
      ...DOCUMENT_HEADERS,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  };
}
