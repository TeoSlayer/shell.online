/**
 * Workshop preview harness: isolated, unauthenticated test page.
 *
 * NOT a public route. State is lifted to WorkshopPreview so the selector
 * buttons actually change the scene (not just their own styling).
 */
import { useState } from "react";
import { WorkshopStage } from "./WorkshopStage";
import type { WorkerInput } from "./WorkshopScene";

type Mode = "team" | "3" | "8" | "24";

const TEAM_FIXTURE: WorkerInput[] = [
  // Owner 1 (attested collaborator) — 2 workers
  { id: "ses_a1", alias: "Agent 1", ownerUid: "owner-alpha", pose: { evidence: "busy", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  { id: "ses_a2", alias: "Agent 2", ownerUid: "owner-alpha", pose: { evidence: "output", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  // Owner 2 (attested collaborator) — 2 workers
  { id: "ses_b1", alias: "Agent 3", ownerUid: "owner-beta", pose: { evidence: "idle", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  { id: "ses_b2", alias: "Agent 4", ownerUid: "owner-beta", pose: { evidence: "waiting_input", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  // Owner 3 (restricted — no activity sharing) — 2 workers
  { id: "ses_c1", alias: "Agent 5", ownerUid: "owner-gamma", pose: { evidence: "unknown", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  { id: "ses_c2", alias: "Agent 6", ownerUid: "owner-gamma", pose: { evidence: "unknown", connection: "stale", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
];

const THREE_FIXTURE: WorkerInput[] = [
  { id: "ses_alpha", alias: "Agent 1", ownerUid: "owner-cal", pose: { evidence: "busy", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  { id: "ses_beta", alias: "Agent 2", ownerUid: "owner-cal", pose: { evidence: "output", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
  { id: "ses_gamma", alias: "Agent 3", ownerUid: "owner-cal", pose: { evidence: "unknown", connection: "connected", receiving: false, attention: false, reducedMotion: false, elapsedMs: 0 }, facing: "down" },
];

const EIGHT_FIXTURE: WorkerInput[] = Array.from({ length: 8 }, (_, i) => ({
  id: `ses_w${i}`,
  alias: `Agent ${i + 1}`,
  ownerUid: i < 4 ? "owner-alpha" : "owner-beta",
  pose: {
    evidence: (["busy", "idle", "output", "unknown"] as const)[i % 4],
    connection: "connected" as const,
    receiving: i === 3,
    attention: i === 5,
    reducedMotion: false,
    elapsedMs: 0,
  },
  facing: "down" as const,
}));

const TWENTYFOUR_FIXTURE: WorkerInput[] = Array.from({ length: 24 }, (_, i) => ({
  id: `ses_v${i}`,
  alias: `Agent ${i + 1}`,
  ownerUid: i < 8 ? "owner-alpha" : i < 16 ? "owner-beta" : i < 20 ? "owner-gamma" : null,
  pose: {
    evidence: (["busy", "idle", "output", "unknown", "waiting_input"] as const)[i % 5],
    connection: i === 20 ? ("stale" as const) : i === 22 ? ("disconnected" as const) : ("connected" as const),
    receiving: false,
    attention: i % 7 === 3,
    reducedMotion: false,
    elapsedMs: 0,
  },
  facing: "down" as const,
}));

function fixtureFor(mode: Mode): WorkerInput[] {
  switch (mode) {
    case "team": return TEAM_FIXTURE;
    case "3": return THREE_FIXTURE;
    case "8": return EIGHT_FIXTURE;
    case "24": return TWENTYFOUR_FIXTURE;
  }
}

export function WorkshopPreview() {
  const [mode, setMode] = useState<Mode>("team");
  const [reduced, setReduced] = useState(false);
  const [page, setPage] = useState(0);

  const workers = fixtureFor(mode);
  const ownerUid = "owner-alpha";
  const totalPages = Math.ceil(workers.length / 8);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0a1a" }}>
      <div style={{ padding: "8px 16px", background: "#111", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "#666", fontFamily: "monospace", fontSize: 11, marginRight: 8 }}>
          Workshop preview (geometry placeholders)
        </span>
        <button onClick={() => { setMode("team"); setPage(0); }} style={btn(mode === "team")}>Team (3 owners)</button>
        <button onClick={() => { setMode("3"); setPage(0); }} style={btn(mode === "3")}>3 workers</button>
        <button onClick={() => { setMode("8"); setPage(0); }} style={btn(mode === "8")}>8 workers</button>
        <button onClick={() => { setMode("24"); setPage(0); }} style={btn(mode === "24")}>24 workers</button>
        <button onClick={() => setReduced(!reduced)} style={btn(reduced)}>Reduced motion</button>
        {totalPages > 1 && (
          <span style={{ display: "flex", gap: 4, marginLeft: 8 }}>
            {Array.from({ length: totalPages }, (_, p) => (
              <button key={p} onClick={() => setPage(p)} style={btn(page === p)}>P{p + 1}</button>
            ))}
          </span>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <WorkshopStage
          workers={workers}
          ownerUid={ownerUid}
          page={page}
          reducedMotion={reduced}
          label="Workshop preview"
        />
      </div>
    </div>
  );
}

function btn(active: boolean): React.CSSProperties {
  return {
    background: active ? "#334" : "#222",
    color: active ? "#fff" : "#888",
    border: `1px solid ${active ? "#556" : "#333"}`,
    borderRadius: 4,
    padding: "4px 10px",
    fontFamily: "monospace",
    fontSize: 11,
    cursor: "pointer",
  };
}
