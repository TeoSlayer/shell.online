import type { Work } from "../world/sim";

/**
 * A garrison to show when there are no live sessions.
 *
 * An empty map is the correct picture of an account with nothing running, and
 * it is also a terrible first impression: a keep with nobody in it and no way
 * to tell whether that is the point or a fault. So this stands in, and the HUD
 * says plainly that it is standing in.
 *
 * It carries plausible session facts so that clicking one shows the same panel
 * a real session would, rather than a panel with holes in it.
 */
export const DEMO_GARRISON = [
  { id: "demo-1", name: "fix: audit seal", kind: "claude-code", work: "bug" as Work },
  { id: "demo-2", name: "feat: session board", kind: "codex", work: "feature" as Work },
  { id: "demo-3", name: "chore: rotate keys", kind: "hermes", work: "idle" as Work },
  { id: "demo-4", name: "fix: relay reconnect", kind: "openclaw", work: "bug" as Work },
  { id: "demo-5", name: "npm run dev", kind: "terminal", work: "idle" as Work },
].map((entry, index) => ({
  ...entry,
  /*
   * The stand-in garrison carries plausible session facts, so clicking one
   * shows the same panel a real session would rather than a panel with holes
   * in it. The interface says elsewhere, plainly, that these are an example.
   */
  session: {
    id: entry.id,
    startedAt: Date.now() - (index + 1) * 11 * 60_000,
    host: ["laptop", "workshop", "builder-01", "laptop", "workshop"][index],
    command: entry.name,
  },
}));
