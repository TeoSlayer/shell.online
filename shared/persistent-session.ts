const PERSISTENT_SESSION_DOMAIN = "shell.online persistent session\0";

export async function persistentSessionID(hostToken: string): Promise<string> {
  const value = new TextEncoder().encode(PERSISTENT_SESSION_DOMAIN + hostToken);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value)).subarray(0, 24);
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
