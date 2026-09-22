import { describe, expect, it } from "vitest";
import { intoParagraphs, looksPreformatted } from "./paragraphs";
import { plainLine } from "./transcript";

const lines = (...texts: string[]) => texts.map(plainLine);
const shapes = (texts: string[]) =>
  intoParagraphs(texts.map(plainLine)).map((p) => `${p.preformatted ? "pre" : "prose"}:${p.lines.length}`);

describe("cutting output into messages", () => {
  it("breaks on a blank line, because that is the break a person already reads", () => {
    const paragraphs = intoParagraphs(lines("On branch main", "", "nothing to commit"));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].lines.map((l) => l.text)).toEqual(["On branch main"]);
    expect(paragraphs[1].lines.map((l) => l.text)).toEqual(["nothing to commit"]);
  });

  it("treats a run of blank lines as one break, not several empty messages", () => {
    expect(intoParagraphs(lines("first", "", "", "", "second"))).toHaveLength(2);
  });

  it("does not end on an empty message", () => {
    expect(intoParagraphs(lines("only", "", ""))).toHaveLength(1);
  });

  it("gives back nothing for nothing", () => {
    expect(intoParagraphs(lines("", "  ", ""))).toEqual([]);
  });
});

describe("prose and pictures", () => {
  it("lets sentences wrap", () => {
    expect(
      looksPreformatted(lines("fatal: could not read from the remote repository.", "Please check your access.")),
    ).toBe(false);
  });

  it("keeps a listing with columns exactly as it was written", () => {
    expect(looksPreformatted(lines("a.txt    1.2K  Sep 20", "b.txt    4.0K  Sep 21"))).toBe(true);
  });

  it("keeps anything drawn rather than written", () => {
    expect(looksPreformatted(lines("┌─┐"))).toBe(true);
    expect(looksPreformatted(lines("│ ok │"))).toBe(true);
  });

  it("keeps an indented block, such as a tree or a stack trace", () => {
    expect(
      looksPreformatted(lines("Changes not staged:", "    modified: a.ts", "    modified: b.ts")),
    ).toBe(true);
  });

  /*
   * One line has nothing to line up with, so it is prose unless it is itself
   * a row of columns.
   */
  it("treats a lone sentence as prose and a lone row as a row", () => {
    expect(looksPreformatted(lines("Cloning into 'api'..."))).toBe(false);
    expect(looksPreformatted(lines("NAME      READY   STATUS"))).toBe(true);
  });

  it("protects a table whose heading row looks ordinary", () => {
    expect(
      looksPreformatted(lines("Results", "pass    41    0.4s", "fail     1    5.6s")),
    ).toBe(true);
  });
});

describe("a whole answer", () => {
  it("becomes prose and pictures in the order they were printed", () => {
    expect(
      shapes([
        "On branch chat-renderer",
        "",
        "Changes not staged for commit:",
        "    modified:   renderer.ts",
        "    modified:   Workspace.tsx",
        "",
        "no changes added to commit",
      ]),
    ).toEqual(["prose:1", "pre:3", "prose:1"]);
  });
});

describe("output with no blank line in it", () => {
  /*
   * Plenty of programs never print one. Split only on blank lines, the whole
   * of an `npm ERR!` block, a stack trace or a help screen arrives as a
   * single bubble, which is the wall of terminal output this renderer exists
   * to replace.
   */
  it("starts a new message where a list returns to the margin", () => {
    /*
     * Each failure keeps the frames hanging off it and lets go of the next
     * one, which is how a person reads a log with two errors in it.
     */
    expect(
      shapes([
        "Error: connect ECONNREFUSED 127.0.0.1:5432",
        "    at TCPConnectWrap.afterConnect (node:net:1595:16)",
        "    at process.processTicksAndRejections (node:internal:82:21)",
        "Warning: retrying the connection in five seconds",
        "    at Timeout._onTimeout (/app/db.js:22:9)",
      ]),
    ).toEqual(["pre:3", "pre:2"]);
  });

  it("separates sentences from the table that follows them", () => {
    expect(
      shapes([
        "Ran 3 suites against the staging cluster.",
        "Two of them needed a retry before they settled.",
        "NAME      READY   STATUS",
        "api       1/1     Running",
        "worker    1/1     Running",
      ]),
    ).toEqual(["prose:2", "pre:3"]);
  });

  it("keeps a table's own heading row attached to the table", () => {
    expect(
      shapes([
        "Results",
        "pass    41    0.4s",
        "fail     1    5.6s",
      ]),
    ).toEqual(["pre:3"]);
  });

  it("does not cut a paragraph in half around one odd line", () => {
    expect(
      shapes([
        "Cloning into 'api'...",
        "remote: Enumerating objects",
        "  resolving deltas",
        "done.",
      ]),
    ).toEqual(["prose:2", "prose:1", "prose:1"]);
  });
});
