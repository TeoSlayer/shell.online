import { describe, expect, it } from "vitest";
import {
  reduceActivity,
  reduceRequests,
} from "./activity";
import {
  T0,
  agentEvent,
  crossOwnerHandoff,
  handoffRequest,
  makeSession,
  messageEvent,
  mcpRequestEvent,
  outputEvent,
  oneOwnerThreeWorkers,
  offlineRoster,
  teamRoster,
} from "./fixtures";
import { parseWorkshopRequest } from "./contracts";

const NOW = T0;

describe("activity reduction", () => {
  it("shows the three M1 workers distinctly: working, output, quiet-unknown", () => {
    const [busy, output, quiet] = oneOwnerThreeWorkers(NOW);
    expect(reduceActivity(busy, NOW).state.kind).toBe("working");
    expect(reduceActivity(output, NOW).state.kind).toBe("output_observed");
    const quietState = reduceActivity(quiet, NOW);
    expect(quietState.state.kind).toBe("quiet_unknown");
    expect(quietState.label).not.toContain("Idle");
  });

  it("ages fresh output to unknown once it leaves the 8s window", () => {
    const session = makeSession(NOW, { events: [outputEvent(1, NOW - 3_000)] });
    expect(reduceActivity(session, NOW).state.kind).toBe("output_observed");
    expect(reduceActivity(session, NOW + 4_000).state.kind).toBe("output_observed");
    expect(reduceActivity(session, NOW + 11_000).state.kind).toBe("quiet_unknown");
  });

  it("lets a stale or disconnected feed override fresh-looking work", () => {
    for (const session of offlineRoster(NOW)) {
      const activity = reduceActivity(session, NOW);
      expect(activity.state.kind).toBe("offline");
      expect(activity.evidence.kind).toBe("unknown");
    }
    const stale = makeSession(NOW, { connection: "stale", events: [agentEvent("busy", 1, NOW - 1_000)] });
    expect(reduceActivity(stale, NOW).label).toContain("Stale");
  });

  it("treats an unknown connection and a legacy host as explicit, not idle", () => {
    expect(reduceActivity(makeSession(NOW, { connection: "unknown" }), NOW).state.kind).toBe("quiet_unknown");
    const legacy = makeSession(NOW, { activitySupported: false, events: [outputEvent(1, NOW - 1_000)] });
    const activity = reduceActivity(legacy, NOW);
    expect(activity.state.kind).toBe("unsupported");
    expect(activity.label).toContain("Update/restart");
  });

  it("prefers needs-input and confirmed busy over observed output", () => {
    const needsInput = makeSession(NOW, {
      events: [agentEvent("waiting_input", 1, NOW - 1_000), outputEvent(2, NOW - 1_000)],
    });
    expect(reduceActivity(needsInput, NOW).state.kind).toBe("needs_input");
    const busyWithOutput = makeSession(NOW, {
      events: [agentEvent("busy", 1, NOW - 1_000), outputEvent(2, NOW - 1_000)],
    });
    expect(reduceActivity(busyWithOutput, NOW).state.kind).toBe("working");
    const idleWithOutput = makeSession(NOW, {
      events: [agentEvent("idle", 1, NOW - 1_000), outputEvent(2, NOW - 1_000)],
    });
    expect(reduceActivity(idleWithOutput, NOW).state.kind).toBe("output_observed");
  });
});

describe("freshness is sequence- and run-bound", () => {
  it("never lets a snapshot or a repeated poll create new activity", () => {
    const aged = makeSession(NOW, { events: [outputEvent(1, NOW - 10_000)] });
    expect(reduceActivity(aged, NOW).state.kind).toBe("quiet_unknown");
    // The same cached events, re-polled later, only age further.
    const repolled = makeSession(NOW + 5_000, {
      receivedAt: NOW + 5_000,
      events: [outputEvent(1, NOW - 10_000)],
    });
    expect(reduceActivity(repolled, NOW + 5_000).state.kind).toBe("quiet_unknown");
    // Reducing the very same session twice is stable.
    expect(reduceActivity(aged, NOW)).toEqual(reduceActivity(aged, NOW));
  });

  it("keeps the source timestamp when re-polling cached values", () => {
    const sourceAt = NOW - 3_000;
    const first = reduceActivity(makeSession(NOW, { events: [outputEvent(1, sourceAt)] }), NOW);
    expect(first.evidence).toEqual({ kind: "host_output", observedAt: sourceAt, sequence: 1 });
    const repolled = reduceActivity(
      makeSession(NOW + 2_000, { receivedAt: NOW + 2_000, events: [outputEvent(1, sourceAt)] }),
      NOW + 2_000,
    );
    expect(repolled.evidence).toEqual({ kind: "host_output", observedAt: sourceAt, sequence: 1 });
  });

  it("lets an out-of-order or old-run event fail to revive aged work", () => {
    // A late low-sequence event carries a fresh stamp, but the run's frontier is old.
    const outOfOrder = makeSession(NOW, {
      events: [outputEvent(10, NOW - 10_000), outputEvent(5, NOW - 1_000)],
    });
    expect(reduceActivity(outOfOrder, NOW).state.kind).toBe("quiet_unknown");
    // An event from a previous run never counts for the current run.
    const oldRun = makeSession(NOW, { events: [outputEvent(20, NOW - 1_000, "run-0000")] });
    expect(reduceActivity(oldRun, NOW).state.kind).toBe("quiet_unknown");
  });
});

describe("request lifecycle", () => {
  it("keeps reads out of the instruction packets", () => {
    const session = makeSession(NOW, {
      events: [
        mcpRequestEvent("read-1", 1, NOW - 1_000, { tool: "shell_status", phase: "settled", outcome: "ok" }),
        mcpRequestEvent("send-1", 2, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
      ],
    });
    const views = reduceRequests(session, NOW);
    expect(views.packets).toHaveLength(1);
    expect(views.packets[0].requestId).toBe("send-1");
    expect(views.reads).toHaveLength(1);
    expect(views.reads[0].requestId).toBe("read-1");
  });

  it("deduplicates identical request transitions to a single packet", () => {
    const session = makeSession(NOW, {
      events: [
        mcpRequestEvent("send-1", 1, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
        mcpRequestEvent("send-1", 2, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
      ],
    });
    expect(reduceRequests(session, NOW).packets).toHaveLength(1);
  });

  it("reports a lost completion as uncertain, never as a success", () => {
    // The host says delivery is uncertain — not a success.
    const lost = makeSession(NOW, {
      events: [mcpRequestEvent("send-1", 1, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivery_uncertain" })],
    });
    const lostView = reduceRequests(lost, NOW).packets[0];
    expect(lostView.phase).toBe("uncertain");
    expect(lostView.label).toContain("uncertain");

    // Still in flight: awaiting delivery, not delivered.
    const inFlight = makeSession(NOW, {
      events: [mcpRequestEvent("send-2", 1, NOW - 1_000, { tool: "shell_send", phase: "started" })],
    });
    expect(reduceRequests(inFlight, NOW).packets[0].phase).toBe("submitted");

    const delivered = makeSession(NOW, {
      events: [mcpRequestEvent("send-3", 1, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered" })],
    });
    expect(reduceRequests(delivered, NOW).packets[0].phase).toBe("delivered");
  });

  it("coalesces retries of one operation into a single packet", () => {
    // Two attempts, different request ids, the same operation id: one packet.
    const session = makeSession(NOW, {
      events: [
        mcpRequestEvent("send-a", 1, NOW - 2_000, { tool: "shell_send", phase: "started", operationId: "op-1" }),
        mcpRequestEvent("send-b", 2, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered", operationId: "op-1" }),
      ],
    });
    const views = reduceRequests(session, NOW);
    expect(views.packets).toHaveLength(1);
    expect(views.packets[0].operationId).toBe("op-1");
    expect(views.packets[0].phase).toBe("delivered");

    // A different operation id is a different packet.
    const other = makeSession(NOW, {
      events: [
        mcpRequestEvent("send-c", 1, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered", operationId: "op-2" }),
      ],
    });
    expect(reduceRequests(other, NOW).packets).toHaveLength(1);
    expect(reduceRequests(other, NOW).packets[0].operationId).toBe("op-2");
  });

  it("drops stale and future-dated observations from the display", () => {
    // A five-minute-old in-flight read is gone, not still "Reading".
    const staleRead = makeSession(NOW, {
      events: [mcpRequestEvent("read-old", 1, NOW - 300_000, { tool: "shell_status", phase: "started" })],
    });
    expect(reduceRequests(staleRead, NOW).reads).toHaveLength(0);

    // A future-dated send (beyond the skew bound) is not shown as delivered.
    const futureSend = makeSession(NOW, {
      events: [mcpRequestEvent("send-future", 1, NOW + 60_000, { tool: "shell_send", phase: "settled", outcome: "delivered" })],
    });
    expect(reduceRequests(futureSend, NOW).packets).toHaveLength(0);
  });

  it("treats output after an ACK as new output, not a reply", () => {
    const requestId = "send-1";
    const withOutput = makeSession(NOW, {
      events: [
        mcpRequestEvent(requestId, 1, NOW - 4_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
        outputEvent(2, NOW - 1_000),
      ],
    });
    const afterOutput = reduceRequests(withOutput, NOW).packets[0];
    expect(afterOutput.responseReceived).toBeFalsy();

    const withReply = makeSession(NOW, {
      events: [
        mcpRequestEvent(requestId, 1, NOW - 4_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
        messageEvent(requestId, 3, NOW - 1_000),
      ],
    });
    expect(reduceRequests(withReply, NOW).packets[0].responseReceived).toBe(true);

    // A reply whose own expiry has passed does not count, even with a fresh stamp.
    const expiredReply = makeSession(NOW, {
      events: [
        mcpRequestEvent(requestId, 1, NOW - 4_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
        { type: "message_available", eventId: "msg-expired", runId: "run-0001", sequence: 3, observedAt: NOW - 1_000, expiresAt: NOW - 500, replyTo: requestId },
      ],
    });
    expect(reduceRequests(expiredReply, NOW).packets[0].responseReceived).toBe(false);
  });
});

describe("evidence expiry is enforced, not just the window", () => {
  it("does not animate work from an event whose expiry has already passed", () => {
    // Observed 1s ago but the producer declared it expired 500ms ago.
    const expiredBusy = makeSession(NOW, {
      events: [{ type: "agent_state", eventId: "e1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW - 500, state: "busy" }],
    });
    expect(reduceActivity(expiredBusy, NOW).state.kind).toBe("quiet_unknown");

    // The same event, still inside its expiry, does animate work.
    const liveBusy = makeSession(NOW, {
      events: [{ type: "agent_state", eventId: "e1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW + 44_000, state: "busy" }],
    });
    expect(reduceActivity(liveBusy, NOW).state.kind).toBe("working");
  });
});

describe("identity is resolved deterministically", () => {
  it("rejects a same-id busy/idle conflict, and array order cannot change it", () => {
    const busy = agentEvent("busy", 5, NOW - 1_000);
    const idle = agentEvent("idle", 5, NOW - 1_000);
    // Both share the builder's eventId (agent-run-0001-5): a conflict.
    expect(busy.eventId).toBe(idle.eventId);
    const forward = reduceActivity(makeSession(NOW, { events: [busy, idle] }), NOW);
    const reversed = reduceActivity(makeSession(NOW, { events: [idle, busy] }), NOW);
    expect(forward.state.kind).toBe("quiet_unknown");
    expect(forward).toEqual(reversed);
  });

  it("dedupes exact repeats into a single driving event", () => {
    const busy = agentEvent("busy", 5, NOW - 1_000);
    const session = makeSession(NOW, { events: [busy, { ...busy }] });
    expect(reduceActivity(session, NOW).state.kind).toBe("working");
  });

  it("fails closed on a contradictory sequence tie across distinct ids", () => {
    // Two distinct ids claim the same sequence with different states: the
    // frontier is contradictory, so it fails closed rather than picking one.
    const a = { type: "agent_state" as const, eventId: "e1", runId: "run-0001", sequence: 5, observedAt: NOW - 1_000, expiresAt: NOW + 44_000, state: "busy" as const };
    const b = { type: "agent_state" as const, eventId: "e2", runId: "run-0001", sequence: 5, observedAt: NOW - 1_000, expiresAt: NOW + 44_000, state: "idle" as const };
    const forward = reduceActivity(makeSession(NOW, { events: [a, b] }), NOW);
    const reversed = reduceActivity(makeSession(NOW, { events: [b, a] }), NOW);
    expect(forward.state.kind).toBe("quiet_unknown");
    expect(forward).toEqual(reversed);
  });

  it("does not fall back to an earlier fresh fact when the newest is contradictory", () => {
    // The newest fact (sequence 10) is a same-id conflict; the older sequence 5
    // is fresh. The contradiction must fail closed, not revive sequence 5.
    const conflictedNew = { type: "output_observed" as const, eventId: "out-10", runId: "run-0001", sequence: 10, observedAt: NOW - 10_000, expiresAt: NOW - 2_000, byteCount: 100 };
    const conflictedNew2 = { type: "output_observed" as const, eventId: "out-10", runId: "run-0001", sequence: 10, observedAt: NOW - 10_000, expiresAt: NOW - 2_000, byteCount: 200 };
    const olderFresh = outputEvent(5, NOW - 1_000);
    const session = makeSession(NOW, { events: [conflictedNew, conflictedNew2, olderFresh] });
    expect(reduceActivity(session, NOW).state.kind).toBe("quiet_unknown");
    // Without the conflict, the aged sequence-10 frontier still blocks revival.
    const clean = makeSession(NOW, { events: [conflictedNew, olderFresh] });
    expect(reduceActivity(clean, NOW).state.kind).toBe("quiet_unknown");
  });
});

describe("team premise", () => {
  it("presents unshared crew sessions as restricted, distinct from idle and unknown", () => {
    const roster = teamRoster(NOW);
    const byId = new Map(roster.map((session) => [session.sessionId, session]));
    // Shared crew: real states.
    expect(reduceActivity(byId.get("a-lead")!, NOW).state.kind).toBe("working");
    expect(reduceActivity(byId.get("b-lead")!, NOW).state.kind).toBe("idle");
    // Unshared: restricted, even though it has fresh busy/output evidence.
    const privateB = reduceActivity(byId.get("b-private")!, NOW);
    const privateC = reduceActivity(byId.get("c-lead")!, NOW);
    expect(privateB.state.kind).toBe("restricted");
    expect(privateC.state.kind).toBe("restricted");
    expect(privateB.label).toContain("Activity not shared");
    // Restricted is its own state, not idle or quiet-unknown.
    expect(privateB.state).not.toEqual({ kind: "idle" });
    expect(privateB.state).not.toEqual({ kind: "quiet_unknown" });
  });

  it("keeps three crews under distinct owners for colour provenance", () => {
    const owners = new Set(teamRoster(NOW).map((session) => session.ownerUid));
    expect(owners).toEqual(new Set(["owner-a", "owner-b", "owner-c"]));
  });

  it("carries an attested cross-owner handoff as service-attested source", () => {
    const request = handoffRequest(NOW);
    expect(parseWorkshopRequest(request, NOW)).not.toBeNull();
    expect(request.source).toEqual({ kind: "attested_session", sessionId: "a-lead" });
    // The target session shows the delivered handoff and its correlated reply.
    const views = reduceRequests(crossOwnerHandoff(NOW), NOW);
    expect(views.packets).toHaveLength(1);
    expect(views.packets[0].phase).toBe("delivered");
    expect(views.packets[0].responseReceived).toBe(true);
  });

  it("respects an explicit null owner as neutral, not a default crew", () => {
    expect(makeSession(NOW, { ownerUid: null }).ownerUid).toBeNull();
    expect(makeSession(NOW, {}).ownerUid).toBe("owner-0001");
  });
});

describe("re-review regressions", () => {
  it("closes the request/reply privacy boundary, not just the worker pose", () => {
    const session = makeSession(NOW, {
      activityShared: false,
      events: [
        mcpRequestEvent("send-1", 1, NOW - 1_000, { tool: "shell_send", phase: "settled", outcome: "delivered" }),
        mcpRequestEvent("read-1", 2, NOW - 1_000, { tool: "shell_screen", phase: "started" }),
        messageEvent("send-1", 3, NOW - 1_000),
      ],
    });
    expect(reduceActivity(session, NOW).state.kind).toBe("restricted");
    const views = reduceRequests(session, NOW);
    expect(views.packets).toHaveLength(0);
    expect(views.reads).toHaveLength(0);
  });

  it("keeps an unresolved send visible as uncertain through its deadline, then drops it", () => {
    // Started, observed 1s ago, delivery deadline now.
    const started = { type: "mcp_request" as const, eventId: "req-1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW, requestId: "send-1", tool: "shell_send" as const, phase: "started" as const };
    const session = makeSession(NOW, { events: [started] });
    expect(reduceRequests(session, NOW - 1).packets[0].phase).toBe("submitted");
    expect(reduceRequests(session, NOW).packets[0].phase).toBe("uncertain");
    expect(reduceRequests(session, NOW + 1).packets[0].phase).toBe("uncertain");
    // Still within the bounded observation age: uncertain, not gone.
    expect(reduceRequests(session, NOW + 118_999).packets[0].phase).toBe("uncertain");
    // Past the bounded age: dropped.
    expect(reduceRequests(session, NOW + 119_000).packets).toHaveLength(0);
  });

  it("does not let a later retry downgrade an already-delivered operation", () => {
    const session = makeSession(NOW, {
      events: [
        mcpRequestEvent("a", 1, NOW - 2_000, { tool: "shell_send", phase: "settled", outcome: "delivered", operationId: "op-1" }),
        mcpRequestEvent("b", 2, NOW - 1_000, { tool: "shell_send", phase: "started", operationId: "op-1" }),
      ],
    });
    const views = reduceRequests(session, NOW);
    expect(views.packets).toHaveLength(1);
    expect(views.packets[0].phase).toBe("delivered");
  });

  it("does not merge a send's operation id with a read's request id", () => {
    const session = makeSession(NOW, {
      events: [
        mcpRequestEvent("send-x", 1, NOW - 2_000, { tool: "shell_send", phase: "settled", outcome: "delivered", operationId: "collision" }),
        mcpRequestEvent("collision", 2, NOW - 1_000, { tool: "shell_screen", phase: "started" }),
      ],
    });
    const views = reduceRequests(session, NOW);
    expect(views.packets).toHaveLength(1);
    expect(views.reads).toHaveLength(1);
    expect(views.packets[0].phase).toBe("delivered");
  });

  it("rejects a same-id request conflict deterministically (order-independent)", () => {
    const delivered = { type: "mcp_request" as const, eventId: "req-1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW + 119_000, requestId: "send-1", tool: "shell_send" as const, phase: "settled" as const, outcome: "delivered" };
    const denied = { ...delivered, outcome: "denied" };
    const forward = reduceRequests(makeSession(NOW, { events: [delivered, denied] }), NOW);
    const reversed = reduceRequests(makeSession(NOW, { events: [denied, delivered] }), NOW);
    expect(forward.packets).toEqual(reversed.packets);
    expect(forward.packets).toHaveLength(0);
  });

  it("does not let a conflicting reply set responseReceived", () => {
    const send = mcpRequestEvent("send-1", 1, NOW - 4_000, { tool: "shell_send", phase: "settled", outcome: "delivered" });
    const replyA = { type: "message_available" as const, eventId: "msg-1", runId: "run-0001", sequence: 2, observedAt: NOW - 1_000, expiresAt: NOW + 119_000, replyTo: "send-1" };
    const replyB = { ...replyA, replyTo: "other" };
    const session = makeSession(NOW, { events: [send, replyA, replyB] });
    expect(reduceRequests(session, NOW).packets[0].responseReceived).toBe(false);
  });

  it("detects a cross-type eventId conflict and fails closed", () => {
    const asAgent = { type: "agent_state" as const, eventId: "shared-1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW + 44_000, state: "busy" as const };
    const asOutput = { type: "output_observed" as const, eventId: "shared-1", runId: "run-0001", sequence: 1, observedAt: NOW - 1_000, expiresAt: NOW + 8_000 };
    const session = makeSession(NOW, { events: [asAgent, asOutput] });
    expect(reduceActivity(session, NOW).state.kind).toBe("quiet_unknown");
  });

  it("enforces the fixed observation age, not an unchecked supplied expiry", () => {
    const oldRead = { type: "mcp_request" as const, eventId: "req-old", runId: "run-0001", sequence: 1, observedAt: NOW - 300_000, expiresAt: NOW + 86_400_000, requestId: "read-old", tool: "shell_screen" as const, phase: "started" as const };
    const session = makeSession(NOW, { events: [oldRead] });
    expect(reduceRequests(session, NOW).reads).toHaveLength(0);
  });
});
