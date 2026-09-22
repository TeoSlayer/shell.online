import { describe, expect, it } from "vitest";
import { RepaintReader } from "./stream";

/*
 * The frames below are what an agent's interface actually does to a screen:
 * it holds still, it grows at the bottom, it scrolls, and it starts again.
 * The last line of each is the row being written, which is never given out.
 */
describe("reading a repainted screen as a log", () => {
  it("gives out nothing for a screen nobody has written to yet", () => {
    const reader = new RepaintReader();
    expect(reader.read(["", "", ""])).toEqual([]);
  });

  it("gives out what is on the screen, except the row still being written", () => {
    const reader = new RepaintReader();
    expect(reader.read(["one", "two", "three"])).toEqual(["one", "two"]);
  });

  it("gives out nothing at all for a frame that changed nothing", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three"]);
    expect(reader.read(["one", "two", "three"])).toEqual([]);
  });

  it("gives out only what grew at the bottom", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three"]);
    expect(reader.read(["one", "two", "three", "four"])).toEqual(["three"]);
  });

  /*
   * The case the whole module exists for. The conversation scrolls up through
   * the grid, so a line that was given out three frames ago is now nowhere on
   * the screen, and the frame starts partway through what is already known.
   */
  it("gives out only what a scroll revealed", () => {
    const reader = new RepaintReader();
    reader.read(["a", "b", "c", "d", "e"]);
    expect(reader.read(["c", "d", "e", "f", "g"])).toEqual(["e", "f"]);
  });

  it("does not give a line out twice however far the screen scrolls", () => {
    const reader = new RepaintReader();
    const given: string[] = [];
    const conversation = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    /* A ten-row screen, scrolled one row at a time, as a program does. */
    for (let top = 0; top + 10 <= conversation.length; top += 1) {
      given.push(...reader.read(conversation.slice(top, top + 10)));
    }
    expect(given).toEqual(given.filter((line, index) => given.indexOf(line) === index));
    expect(given).toEqual(conversation.slice(0, given.length));
  });

  /*
   * A short accidental match is not a scroll. A blank line, or a row of the
   * same box character, appears all over a screen, and taking the shortest
   * match would give the rest of the frame out for a second time.
   */
  it("takes the longest match, not the first one it finds", () => {
    const reader = new RepaintReader();
    reader.read(["", "keep", "", "x"]);
    /* Frame starts with a blank, which also matches a blank further back. */
    expect(reader.read(["", "keep", "", "new", "x"])).toEqual(["new"]);
  });

  it("gives out a screen that shares nothing with the last one in full", () => {
    const reader = new RepaintReader();
    reader.read(["old one", "old two", "x"]);
    expect(reader.read(["new one", "new two", "x"])).toEqual(["new one", "new two"]);
  });

  it("ignores the blank space under a conversation growing and shrinking", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three", "", "", ""]);
    expect(reader.read(["one", "two", "three", ""])).toEqual([]);
  });

  it("forgets the screen when the program does", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three"]);
    reader.reset();
    expect(reader.read(["one", "two", "three"])).toEqual(["one", "two"]);
  });
});

describe("the line a program finished on", () => {
  /*
   * A row still being written and the row a program stopped on are identical
   * in a single frame. The only difference is whether another frame follows,
   * so the caller says when the screen has gone quiet.
   */
  it("is held back until the screen goes quiet, then given out", () => {
    const reader = new RepaintReader();
    expect(reader.read(["one", "two", "three"])).toEqual(["one", "two"]);
    expect(reader.flush()).toEqual(["three"]);
  });

  it("is not given out twice by a flush that follows a flush", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three"]);
    reader.flush();
    expect(reader.flush()).toEqual([]);
  });

  it("is picked up by the next frame when the program was not finished", () => {
    const reader = new RepaintReader();
    reader.read(["one", "two", "three"]);
    expect(reader.read(["one", "two", "three", "four"])).toEqual(["three"]);
    expect(reader.flush()).toEqual(["four"]);
  });
});
