import { describe, expect, it } from "vitest";
import { findMentions, splitMentions } from "./mentions";

const people = [
  { uid: "u1", name: "Ana Ferreira", email: "ana@example.com" },
  { uid: "u2", name: "Ana", email: "ana2@example.com" },
  { uid: "u3", name: "Bruno Silva", email: "bruno@example.com" },
  { uid: "u4", email: "carla@example.com" },
];

describe("findMentions", () => {
  it("finds someone by full name", async () => {
    expect(findMentions("can @Ana Ferreira look at this", people)).toEqual(["u1"]);
  });

  it("prefers the longest matching name", async () => {
    /* Otherwise the wrong Ana is notified. */
    expect(findMentions("@Ana Ferreira please", people)).toEqual(["u1"]);
    expect(findMentions("@Ana please", people)).toEqual(["u2"]);
  });

  it("finds someone with no name by their email handle", async () => {
    expect(findMentions("@carla take a look", people)).toEqual(["u4"]);
  });

  it("finds several people, without duplicates", async () => {
    const found = findMentions("@Bruno Silva and @Bruno Silva and @carla", people);
    expect(found.sort()).toEqual(["u3", "u4"]);
  });

  it("does not match inside a longer word", async () => {
    expect(findMentions("@Anastasia is someone else", people)).toEqual([]);
    expect(findMentions("email ana@example.com directly", people)).toEqual([]);
  });

  it("is case-insensitive", async () => {
    expect(findMentions("@ANA FERREIRA", people)).toEqual(["u1"]);
  });

  it("finds nothing in text with no mention", async () => {
    expect(findMentions("just a comment", people)).toEqual([]);
    expect(findMentions("", people)).toEqual([]);
    expect(findMentions("@nobody", people)).toEqual([]);
  });
});

describe("splitMentions", () => {
  it("separates a mention from the words around it", async () => {
    expect(splitMentions("hey @Ana Ferreira look", people)).toEqual([
      { text: "hey " },
      { text: "@Ana Ferreira", uid: "u1" },
      { text: " look" },
    ]);
  });

  it("leaves an unmatched at-sign as text", async () => {
    expect(splitMentions("email me @ home", people)).toEqual([
      { text: "email me " },
      { text: "@" },
      { text: " home" },
    ]);
  });

  it("keeps the original spelling of the mention", async () => {
    const [, mention] = splitMentions("hi @ana ferreira", people);
    expect(mention).toEqual({ text: "@ana ferreira", uid: "u1" });
  });

  it("handles a comment that is only a mention", async () => {
    expect(splitMentions("@carla", people)).toEqual([{ text: "@carla", uid: "u4" }]);
  });

  it("handles empty text", async () => {
    expect(splitMentions("", people)).toEqual([]);
  });
});
