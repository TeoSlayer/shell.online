export const MAX_SESSION_VIEWERS = 16;
export const SESSION_FULL_CLOSE_CODE = 4005;
export const SESSION_FULL_CLOSE_REASON = "session is full";

export type ViewerAdmission =
  | { accepted: true }
  | { accepted: false; closeCode: number; reason: string };

export function viewerAdmission(activeViewers: number): ViewerAdmission {
  if (activeViewers < MAX_SESSION_VIEWERS) return { accepted: true };
  return {
    accepted: false,
    closeCode: SESSION_FULL_CLOSE_CODE,
    reason: SESSION_FULL_CLOSE_REASON,
  };
}

export function isSessionFullClose(code: number): boolean {
  return code === SESSION_FULL_CLOSE_CODE;
}
