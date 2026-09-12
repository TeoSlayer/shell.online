/** Security policy shared by the Node and Worker app frontends. */
export const BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  /* Firebase Auth uses a popup plus a small iframe on its hosted auth domain. */
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https:",
    "connect-src 'self' wss: https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com",
    "frame-src https://*.firebaseapp.com https://*.web.app https://accounts.google.com",
    "form-action 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
