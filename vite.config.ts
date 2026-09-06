import { defineConfig } from "vite";
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

export default defineConfig({
  plugins: [react()],
  server: { headers: authHeaders },
  preview: { headers: authHeaders },
});
