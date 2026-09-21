import { describe, expect, it } from "vitest";
import { mcpDisclosure } from "../shared/mcp-disclosure";

describe("F8: state-dependent server-decryption disclosure", () => {
  it("E2EE with no decryption capability: plain E2EE disclosure (no MCP decryption claim)", () => {
    const d = mcpDisclosure(true, false, false);
    expect(d.label).toBe("E2EE");
    expect(d.title).not.toMatch(/MCP/i);
    expect(d.title).toContain("end-to-end encrypted");
  });

  it("E2EE with decryption capability: visible MCP label + server-side decryption authorized for the full grant lifetime", () => {
    const d = mcpDisclosure(true, true, false);
    // The MCP authorization is VISIBLE in the badge label, not only in the tooltip.
    expect(d.label).toBe("E2EE · MCP");
    // Full-grant-lifetime wording: "server-side decryption authorized" (not "active MCP agent").
    expect(d.title).toMatch(/server-side decryption authorized/i);
    // The corrected trust-boundary wording: the HOST supplies the frame key to the SERVER, which
    // decrypts the frames and sends the AGENT plaintext (not "the agent holds a server-issued key").
    expect(d.title).toMatch(/host supplies the frame key/i);
    expect(d.title).toMatch(/server/i);
    expect(d.title).toMatch(/decrypt/i);
    expect(d.title).toMatch(/plaintext/i);
  });

  it("persistent E2EE with decryption capability: visible MCP label preserved", () => {
    const d = mcpDisclosure(true, true, true);
    expect(d.label).toBe("Persistent E2EE · MCP");
    expect(d.title).toMatch(/server-side decryption authorized/i);
  });

  it("TLS with no decryption capability: plain TLS disclosure (no MCP read claim)", () => {
    const d = mcpDisclosure(false, false, false);
    expect(d.label).toBe("Transport only");
    expect(d.title).not.toMatch(/MCP/i);
    expect(d.title).toContain("TLS");
  });

  it("TLS with decryption capability: visible MCP label + discloses that the server can read the frames", () => {
    const d = mcpDisclosure(false, true, false);
    expect(d.label).toBe("Transport only · MCP");
    expect(d.title).toMatch(/MCP enabled/i);
    expect(d.title).toContain("TLS");
  });

  it("flips with decryption capability: same session, disclosure tracks the capability", () => {
    const before = mcpDisclosure(true, false, false);
    const after = mcpDisclosure(true, true, false);
    expect(before.title).not.toBe(after.title);
    expect(before.title).not.toMatch(/MCP/i);
    expect(after.title).toMatch(/server-side decryption authorized/i);
  });
});
