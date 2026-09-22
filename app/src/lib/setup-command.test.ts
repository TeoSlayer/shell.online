import { describe, expect, it } from "vitest";
import { SETUP_COMMAND } from "./setup-command";

describe("the setup command", () => {
  it("is a single line someone can paste", () => {
    expect(SETUP_COMMAND).not.toMatch(/\n/);
  });

  /*
   * First-run test: after the bare installer, `shell` was not on PATH on a
   * stock Mac, so the installer runs `shell auth` itself.
   */
  it("links the machine through the installer", () => {
    expect(SETUP_COMMAND).toBe("curl -fsSL https://shell.online/install | sh -s -- auth");
  });

  /* Remote start grants remote execution authority: a choice made at the prompt, never pasted in. */
  it("leaves remote start to the prompt", () => {
    expect(SETUP_COMMAND).not.toContain("--allow-remote-start");
  });
});
