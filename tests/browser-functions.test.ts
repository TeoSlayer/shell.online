import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
// @ts-expect-error -- Node harness helpers are plain ESM.
import { browserFunctionParams, SUBMIT_PASSWORD, GRANT_APPEARED } from "../scripts/staging-harness/browser-functions.mjs";

describe("browser harness structured arguments", () => {
  const hostile = `</script><script>globalThis.injected=true</script>\n\"');globalThis.injected=true;//\u2028\u2029`;

  it("keeps passwords in argument data, never generated code", () => {
    const params = browserFunctionParams("page-global", SUBMIT_PASSWORD, [hostile]);
    const wire = JSON.parse(JSON.stringify(params));
    expect(wire.functionDeclaration).toBe(SUBMIT_PASSWORD);
    expect(wire.functionDeclaration).not.toContain(hostile);
    expect(wire.arguments).toEqual([{ value: hostile }]);

    let submitted = 0;
    const input = { value: "", form: { requestSubmit: () => { submitted++; } } };
    const page = { document: { getElementById: () => input }, injected: false };
    const submit = runInNewContext("(" + SUBMIT_PASSWORD + ")", page);
    expect(submit(wire.arguments[0].value)).toBe(true);
    expect(input.value).toBe(hostile);
    expect(submitted).toBe(1);
    expect(page.injected).toBe(false);
  });

  it("compares agent labels literally, including quotes and code-like text", () => {
    const params = browserFunctionParams("page-global", GRANT_APPEARED, [hostile]);
    const page = {
      document: {
        querySelectorAll: () => [{ textContent: "Agent: " + hostile }],
        getElementById: () => ({ textContent: "E2EE · MCP" }),
      },
      injected: false,
    };
    const appeared = runInNewContext("(" + GRANT_APPEARED + ")", page);
    expect(params.functionDeclaration).not.toContain(hostile);
    expect(appeared(params.arguments[0].value)).toBe(true);
    expect(appeared("different-label")).toBe(false);
    expect(page.injected).toBe(false);
  });
});
