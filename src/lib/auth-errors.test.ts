import { describe, expect, it } from "vitest";
import { FirebaseError } from "firebase/app";
import { authErrorMessage, PASSWORD_LABELS, passwordScore } from "./auth-errors";

describe("authErrorMessage", () => {
  it("maps a known code to plain copy", () => {
    expect(authErrorMessage(new FirebaseError("auth/invalid-email", "raw"))).toBe(
      "That does not look like a valid email address.",
    );
  });

  it("gives the same answer for every wrong-credential shape", () => {
    /* Distinguishing them would tell an attacker which emails have accounts. */
    const codes = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"];
    const messages = new Set(codes.map((code) => authErrorMessage(new FirebaseError(code, "raw"))));
    expect(messages.size).toBe(1);
  });

  it("never leaks a raw firebase code", () => {
    const message = authErrorMessage(new FirebaseError("auth/internal-error", "raw"));
    expect(message).not.toContain("auth/");
    expect(message).toBe("Something went wrong on our side. Try again.");
  });

  it("falls back for a plain error and for a non-error", () => {
    expect(authErrorMessage(new Error("network down"))).toBe("network down");
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
