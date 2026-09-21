import type { Member, SessionAutomationConsent, SessionRecord } from "./api";

export function canManageAutomation(
  session: Pick<SessionRecord, "ownerUid" | "uid">,
  you: Pick<Member, "uid"> | null,
): boolean {
  return Boolean(you?.uid && (session.ownerUid ?? session.uid) === you.uid);
}

export function automationConsent(session: Partial<SessionAutomationConsent>): SessionAutomationConsent {
  return {
    mcpTeamAccess: session.mcpTeamAccess === true,
    dailyBriefingEnabled: session.dailyBriefingEnabled === true,
    dailyBriefingTeamAccess: session.dailyBriefingTeamAccess === true,
  };
}
