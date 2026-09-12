import { describe, expect, it } from "vitest";
import { generatePassword } from "./seal";

describe("generated session passwords", () => {
  it("uses exactly ten base64url characters", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{10}$/);
    }
  });

  it("does not reuse one generated value", () => {
    const generated = new Set(Array.from({ length: 100 }, () => generatePassword()));
    expect(generated.size).toBe(100);
  });
});
