import { describe, expect, it } from "vitest";
import { sealTargets, shareCandidates } from "./session-share";
import type { Member } from "./api";

function member(uid: string, accountKey?: string): Member {
  return {
    orgId: "org",
    uid,
    email: `${uid}@example.com`,
    name: uid,
    role: "member",
    joinedAt: 0,
    accountKey,
  };
}

const you = member("me", "key-me");

describe("who can be offered a session password", () => {
  it("leaves you off your own list", () => {
    const { reachable } = shareCandidates([you, member("a", "key-a")], you);
    expect(reachable.map((entry) => entry.uid)).toEqual(["a"]);
  });

  it("separates people with no vault from people with one", () => {
    const { reachable, unreachable } = shareCandidates(
      [you, member("a", "key-a"), member("b")],
      you,
    );
    expect(reachable.map((entry) => entry.uid)).toEqual(["a"]);
    expect(unreachable.map((entry) => entry.uid)).toEqual(["b"]);
  });

  /* A browser key from before the vault is not somewhere to seal a new password. */
  it("does not count an old browser key as a vault", () => {
    const legacy: Member = { ...member("c"), publicKey: "browser-key" };
    const { reachable, unreachable } = shareCandidates([you, legacy], you);
    expect(reachable).toEqual([]);
    expect(unreachable.map((entry) => entry.uid)).toEqual(["c"]);
  });

  it("offers the whole team to somebody who is not in it", () => {
    const { reachable } = shareCandidates([member("a", "key-a")], null);
    expect(reachable.map((entry) => entry.uid)).toEqual(["a"]);
  });
});

describe("who a session password is sealed to", () => {
  const team = [you, member("a", "key-a"), member("b", "key-b"), member("c")];

  /* The property that matters: not choosing somebody is not sharing with them. */
  it("seals to nobody when nobody was chosen", () => {
    expect(sealTargets({ members: team, you, chosen: [] })).toEqual([]);
  });

  it("seals only to the people chosen", () => {
    const targets = sealTargets({ members: team, you, chosen: ["a"] });
    expect(targets.map((entry) => entry.uid)).toEqual(["a"]);
  });

  it("never seals to you, even if you are on the list", () => {
    const targets = sealTargets({ members: team, you, chosen: ["me", "a"] });
    expect(targets.map((entry) => entry.uid)).toEqual(["a"]);
  });

  it("skips somebody chosen who has no vault to seal to", () => {
    const targets = sealTargets({ members: team, you, chosen: ["c"] });
    expect(targets).toEqual([]);
  });

  it("does not seal twice to the same person", () => {
    const targets = sealTargets({
      members: team,
      you,
      chosen: ["a", "b"],
      done: new Set(["a"]),
    });
    expect(targets.map((entry) => entry.uid)).toEqual(["b"]);
  });

  it("ignores a chosen uid that is not in the team", () => {
    const targets = sealTargets({ members: team, you, chosen: ["nobody"] });
    expect(targets).toEqual([]);
  });
});
