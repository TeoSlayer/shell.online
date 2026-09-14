import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { sendFeedback } from "../lib/api";
import { routeForFeedback } from "../lib/feedback";
import { FeedbackContext, type FeedbackRequest } from "./context";
import { FeedbackSheet } from "./FeedbackSheet";

/**
 * One sheet for the whole app, opened from wherever a FeedbackLink sits.
 *
 * Rendered here rather than by the link that opened it, so it outlives a
 * modal that closes underneath it and reads the same on every screen. It
 * needs a signed-in person: the message is recorded against the account,
 * which is what makes a reply possible.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const [request, setRequest] = useState<FeedbackRequest | null>(null);
  const open = useCallback((next: FeedbackRequest) => setRequest(next), []);
  const close = useCallback(() => setRequest(null), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {request && user && (
        <FeedbackSheet
          email={user.email ?? ""}
          route={routeForFeedback(location.pathname)}
          request={request}
          onSend={sendFeedback}
          onClose={close}
        />
      )}
    </FeedbackContext.Provider>
  );
}
