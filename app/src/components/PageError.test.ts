import { describe, expect, it } from "vitest";
import { PageError } from "./PageError";

/*
 * The boundary itself needs a client render to exercise, which this suite has
 * no DOM for. What it can check is the part that decides what the reader sees,
 * which is the part that used to be nothing at all: before the boundary
 * existed a component that threw took the shell with it, and on a phone that
 * meant the bottom navigation bar disappeared along with the page.
 */
describe("what a page that threw says", () => {
  it("shows the error's own message when it has one", () => {
    expect(PageError.getDerivedStateFromError(new Error("Session list is unavailable")))
      .toEqual({ message: "Session list is unavailable" });
  });

  it("falls back to a sentence for a throw that carries none", () => {
    expect(PageError.getDerivedStateFromError(new Error("")).message)
      .toBe("Something on this page stopped working.");
    expect(PageError.getDerivedStateFromError("not an error").message)
      .toBe("Something on this page stopped working.");
  });
});
