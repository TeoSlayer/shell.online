import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/*
 * The environment is node, so the document the fallback needs is built here.
 * It is small on purpose: the only thing worth asserting is which of the two
 * mechanisms ran, and what each of them was handed.
 */
function fakeDocument() {
  const field = {
    value: "",
    style: { cssText: "" },
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  return {
    field,
    document: {
      activeElement: null,
      createElement: () => field,
      body: { append: vi.fn() },
      execCommand: vi.fn(() => true),
    },
  };
}

let fake = fakeDocument();

beforeEach(() => {
  fake = fakeDocument();
  vi.stubGlobal("document", fake.document);
  vi.stubGlobal("HTMLElement", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copying, when the browser offers the clipboard API", () => {
  it("writes through it and does not touch the fallback", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("shell login")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("shell login");
    expect(fake.document.execCommand).not.toHaveBeenCalled();
  });
});

describe("copying, when the browser refuses the clipboard API", () => {
  /*
   * This is the case a phone actually hits. writeText rejects with
   * NotAllowedError, which the app used to swallow, leaving the button
   * looking as though it had copied something.
   */
  it("falls back to a selection, and reports success", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new DOMException("Write permission denied", "NotAllowedError");
        }),
      },
    });

    await expect(copyText("https://shell.online/s/7f3a91")).resolves.toBe(true);
    expect(fake.field.value).toBe("https://shell.online/s/7f3a91");
    expect(fake.field.setSelectionRange).toHaveBeenCalledWith(0, 29);
    expect(fake.document.execCommand).toHaveBeenCalledWith("copy");
    expect(fake.field.remove).toHaveBeenCalled();
  });

  it("uses the fallback when the API is absent altogether", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyText("shell attach abc")).resolves.toBe(true);
    expect(fake.field.value).toBe("shell attach abc");
  });
});

describe("copying, when nothing works", () => {
  it("reports failure rather than pretending", async () => {
    vi.stubGlobal("navigator", {});
    fake.document.execCommand = vi.fn(() => false);

    await expect(copyText("anything")).resolves.toBe(false);
  });

  it("reports failure when the fallback throws", async () => {
    vi.stubGlobal("navigator", {});
    fake.document.execCommand = vi.fn(() => {
      throw new Error("not allowed here either");
    });

    await expect(copyText("anything")).resolves.toBe(false);
    /* Still tidied away: a stray textarea would outlive the failure. */
    expect(fake.field.remove).toHaveBeenCalled();
  });

  it("refuses an empty value without touching the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(fake.document.execCommand).not.toHaveBeenCalled();
  });
});
