export interface ResizeCandidate {
  id: number;
  connected: boolean;
  guestNumber?: number;
  typingAt?: number;
}

/** Selects exactly one browser that may size the shared PTY. */
export function chooseResizeOwner(
  candidates: readonly ResizeCandidate[],
  currentOwnerId: number | null,
  now: number,
  typingLeaseMs: number,
): number | null {
  const connected = candidates.filter((candidate) => candidate.connected);
  const typist = connected
    .filter((candidate) => candidate.typingAt !== undefined && now - candidate.typingAt < typingLeaseMs)
    .sort((left, right) => (right.typingAt ?? 0) - (left.typingAt ?? 0))[0];
  if (typist) return typist.id;
  if (connected.some((candidate) => candidate.id === currentOwnerId)) return currentOwnerId;
  return connected.sort((left, right) =>
    (left.guestNumber ?? Number.MAX_SAFE_INTEGER) - (right.guestNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.id - right.id
  )[0]?.id ?? null;
}
