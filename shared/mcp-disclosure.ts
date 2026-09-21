// State-dependent MCP trust-boundary disclosure for the session encryption badge. The disclosure
// tracks the FULL grant lifetime ("server authorized to decrypt"), not cipher allocation or agent
// activity: for an E2EE session the host supplies the frame key to the server when a grant is
// minted, so the server is authorized to decrypt for as long as any grant is live (the badge claims
// server-side MCP decryption across that window, and reverts to the plain E2EE / TLS disclosure
// once no grant is live). Kept runtime-neutral so it can be unit tested.
export interface McpDisclosure {
  label: string;
  title: string;
}

export function mcpDisclosure(
  encrypted: boolean,
  mcpDecrypt: boolean,
  persistent: boolean,
): McpDisclosure {
  const base = encrypted ? (persistent ? "Persistent E2EE" : "E2EE") : "Transport only";
  const label = mcpDecrypt ? `${base} · MCP` : base;
  let title: string;
  if (encrypted) {
    title = mcpDecrypt
      ? "MCP enabled — server-side decryption authorized: the host supplies the frame key to the server, which decrypts the frames and sends the agent plaintext."
      : "Terminal frames are end-to-end encrypted between your browser and the host; the server relays them encrypted.";
  } else {
    title = mcpDecrypt
      ? "MCP enabled — the server can read the same frames the browser renders (relayed over TLS)."
      : "Terminal frames are relayed over TLS.";
  }
  return { label, title };
}
