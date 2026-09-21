import { describe, expect, it } from "vitest";
import { readSessionContent } from "./session-content";

const publicKey = "BDxrse1_E7EAHDreFfDYFkHs7kcn3d2n_BqKorrlu6H-9FarvjSDUCUSY3EOYKRBJusTV2E2GwRZLdplZc3UbQY";
const body = { generation: "a".repeat(32), observedAt: 1000, senderPublicKey: publicKey, sealed: `sc1.${Buffer.alloc(40).toString("base64url")}` };

describe("sealed session content validation", () => {
  it("accepts the exact ciphertext size boundary", async () => {
    const input = { ...body, sealed: `sc1.${Buffer.alloc(16 * 1024).toString("base64url")}` };
    expect(await readSessionContent(input)).toEqual(input);
  });
  it.each([
    { generation: "../session" }, { generation: "" },
    { observedAt: -1 }, { observedAt: 1.5 }, { observedAt: Number.MAX_SAFE_INTEGER },
    { senderPublicKey: "A".repeat(87) },
    { sealed: `sc1.${Buffer.alloc(16 * 1024 + 1).toString("base64url")}` },
    { sealed: `sc1.${Buffer.alloc(28).toString("base64url")}` },
    { sealed: "sc1.A===" }, { sealed: "sc1.A" }, { sealed: "plaintext" },
    { suggestedTitle: "never store plaintext" },
  ])("rejects invalid input %#", async (patch) => {
    expect(await readSessionContent({ ...body, ...patch })).toBeNull();
  });
});
