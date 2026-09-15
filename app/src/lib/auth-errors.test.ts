import { describe, expect, it } from "vitest";
import { authErrorMessage, PASSWORD_LABELS, passwordScore } from "./auth-errors";

describe("authErrorMessage", () => {
  it("shows the message of an error that has one", () => {
    expect(authErrorMessage(new Error("network down"))).toBe("network down");
  });

  it("falls back for anything without one", () => {
    expect(authErrorMessage(new Error(""))).toBe("Something went wrong on our side. Try again.");
    expect(authErrorMessage("nonsense")).toBe("Something went wrong on our side. Try again.");
    expect(authErrorMessage(null)).toBe("Something went wrong on our side. Try again.");
  });
});

describe("passwordScore", () => {
  it("scores zero for empty", () => {
    expect(passwordScore("")).toBe(0);
  });

  it("rises with length before variety", () => {
    expect(passwordScore("short")).toBe(0);
    expect(passwordScore("12345678")).toBe(2);
    expect(passwordScore("correcthorse")).toBe(2);
    expect(passwordScore("correct-horse-42")).toBe(3);
    expect(passwordScore("Correct-Horse-42")).toBe(4);
  });

  it("never exceeds the label range", () => {
    for (const value of ["a", "aA1!", "Correct-Horse-Battery-Staple-42!"]) {
      const score = passwordScore(value);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(PASSWORD_LABELS.length);
    }
  });
});
