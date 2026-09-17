import type { Roster } from "./sessions";
import type { Earned } from "./progress";
import type { Work } from "../world/work";

/**
 * A team to show when there is nothing running.
 *
 * An empty map is the correct picture of an account with nothing on it, and it
 * is also a terrible first impression: a country with nobody in it and no way
 * to tell whether that is the point or a fault. So this stands in, and the HUD
 * says plainly that it is standing in.
 *
 * Three heroes rather than one, because the thing worth showing is the shape of
 * the model -- several people, each with their own retinue of their own
 * sessions, in their own camps. One hero with five soldiers would demonstrate
 * half of it and leave the half that is actually novel unexplained.
 *
 * The soldiers carry plausible session facts, so clicking one shows the same
 * panel a real session would rather than a panel with holes in it.
 */

const PEOPLE = [
  { uid: "demo-ada", name: "Ada", characterClass: "claude-code" },
  { uid: "demo-grace", name: "Grace", characterClass: "codex" },
  { uid: "demo-alan", name: "Alan", characterClass: "openclaw" },
];

const WORK: { id: string; name: string; kind: string; work: Work; owner: string }[] = [
  /* Ada, with a retinue of two classes: the case the model is built around. */
  { id: "demo-1", name: "fix: audit seal", kind: "claude-code", work: "bug", owner: "demo-ada" },
  { id: "demo-2", name: "fix: relay reconnect", kind: "claude-code", work: "bug", owner: "demo-ada" },
  { id: "demo-3", name: "feat: session board", kind: "claude-code", work: "feature", owner: "demo-ada" },
  { id: "demo-4", name: "chore: rotate keys", kind: "openclaw", work: "idle", owner: "demo-ada" },

  { id: "demo-5", name: "feat: the road book", kind: "codex", work: "feature", owner: "demo-grace" },
  { id: "demo-6", name: "fix: the shaking", kind: "codex", work: "bug", owner: "demo-grace" },
  { id: "demo-7", name: "npm run dev", kind: "terminal", work: "idle", owner: "demo-grace" },

  { id: "demo-8", name: "feat: the border wood", kind: "openclaw", work: "feature", owner: "demo-alan" },
  { id: "demo-9", name: "debug the importer", kind: "hermes", work: "bug", owner: "demo-alan" },
];

/**
 * What the example team is supposed to have done.
 *
 * The stand-in used to be a roster and nothing else, which left the rest of the
 * game unreachable whenever the service could not be reached: no finished
 * sessions means no experience, no experience means level one, level one means
 * no marks and a shop that will not open. Somebody looking at the example
 * garrison could see the map and none of what the map is for.
 *
 * So the example has an example history too. It is labelled everywhere the
 * roster is -- the HUD says "Example garrison" and the Barrow says the service
 * did not answer -- because a number that looks real and is not is worse than
 * no number. What it buys is the ability to open the shop, spend, and see a
 * skin land on a figure, which cannot otherwise be tried at all without a
 * working service and a week of sessions behind it.
 */
export const DEMO_EARNED: Earned = {
  sessions: 34,
  days: 11,
  machines: 3,
  mended: 14,
  made: 9,
};

export const DEMO_ROSTER: Roster = {
  heroes: PEOPLE,
  soldiers: WORK.map((entry, index) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    work: entry.work,
    heroUid: entry.owner,
    session: {
      id: entry.id,
      startedAt: Date.now() - (index + 1) * 11 * 60_000,
      host: ["laptop", "workshop", "builder-01"][index % 3],
      command: entry.name,
    },
  })),
  /* The first of them is "you", so the point-and-click has a hero to order. */
  youUid: "demo-ada",
  /* The stand-in is small enough that no cap ever touches it. */
  heroTotal: PEOPLE.length,
  soldierTotal: WORK.length,
};
