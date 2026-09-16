import type { Roster } from "./sessions";
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
};
