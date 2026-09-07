/** Matches AGENT_ONLINE_MS on the accounts service. */
export const AGENT_ONLINE_MS = 15_000;

export interface AgentLiveness {
  /** When this machine's daemon last asked the service for work. */
  agentSeenAt?: number;
}

/**
 * True while this machine is reachable from here.
 *
 * A machine becomes reachable when someone agrees to it at `shell login`, and
 * its daemon then polls for as long as it is signed in. This deliberately
 * ignores every other sign of life: a machine that publishes sessions but
 * whose owner did not agree to remote starts is linked, not reachable.
 */
export function machineOnline(device: AgentLiveness, now = Date.now()): boolean {
  return typeof device.agentSeenAt === "number" && now - device.agentSeenAt < AGENT_ONLINE_MS;
}
