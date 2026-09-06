/** Matches AGENT_ONLINE_MS on the accounts service. */
export const AGENT_ONLINE_MS = 15_000;

export interface AgentLiveness {
  /** When `shell agent` last asked the service for work. */
  agentSeenAt?: number;
}

/**
 * True while `shell agent` is polling on that machine.
 *
 * Only a polling agent can carry work out, so this deliberately ignores every
 * other sign of life: a machine that publishes sessions but runs no agent is
 * linked, not listening.
 */
export function agentOnline(device: AgentLiveness, now = Date.now()): boolean {
  return typeof device.agentSeenAt === "number" && now - device.agentSeenAt < AGENT_ONLINE_MS;
}
