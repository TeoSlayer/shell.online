import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/* The link's props are the subject: which page it goes to, and what it carries. */
const links: { to: unknown; state: unknown }[] = [];
vi.mock("react-router-dom", async (original) => {
  const actual = await original<typeof import("react-router-dom")>();
  return {
    ...actual,
    Link: (props: { to: unknown; state?: unknown; children?: unknown }) => {
      links.push({ to: props.to, state: props.state });
      return null;
    },
  };
});

const { AuthShell } = await import("./AuthShell");

describe("the header link", () => {
  /*
   * `shell auth` sends a signed-out browser to /signup with the CLI's request
   * in router state. The header's "Sign in" used to drop it, so signing in
   * from there landed on the sessions list and the terminal waited for a
   * callback that was never coming.
   */
  it("carries the page's router state to the other auth page", () => {
    links.length = 0;
    const from = "/cli/authorize?code_challenge=abc&state=xyz";
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: "/signup", state: { from } }] },
        createElement(AuthShell, {
          title: "Create your account.",
          dek: "",
          headLink: { to: "/login", label: "Sign in" },
          children: null,
        }),
      ),
    );
    /* The wordmark links home too; the header link is the one to /login. */
    expect(links.filter((link) => link.to === "/login")).toEqual([{ to: "/login", state: { from } }]);
  });
});
