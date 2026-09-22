import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

/* The guard is the subject; the sign-in provider it would otherwise reach is not. */
vi.mock("../lib/firebase", () => ({ auth: null }));

const context = {
  mode: "firebase" as const,
  user: null,
  initializing: true,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithProvider: vi.fn(),
  resetPassword: vi.fn(),
  resendVerification: vi.fn(),
  signOutUser: vi.fn(),
  deleteAccount: vi.fn(),
};

const render = () =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        AuthContext.Provider,
        { value: context },
        createElement(RequireAuth, null, createElement("p", null, "the page")),
      ),
    ),
  );

describe("waiting on the session check", () => {
  /*
   * On a phone the shell is what carries the navigation bar along the bottom.
   * The wait used to be a bare card with no shell around it, so the bar was
   * absent for as long as the check took and then appeared underneath the
   * page, which is the bar moving as far as anyone looking at it is concerned.
   */
  it("waits inside the shell, so the bottom bar is already where it belongs", () => {
    const html = render();
    expect(html).toContain("Checking your session");
    expect(html).toContain('class="shell"');
    expect(html).toContain('class="rail-nav"');
  });
});
