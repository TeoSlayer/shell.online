import type {SessionRecord} from "../lib/api";
import {sessionSummary} from "../lib/session-title";
import {SessionMarkdown} from "./SessionMarkdown";

export function SessionSummaryText({session, compact = true}:{session:SessionRecord; compact?: boolean}) {
  const text=sessionSummary(session);
  if(!text)return <>No description.</>;
  return <>
    {session.contentObservedAt && <small title="An excerpt of an existing completed response from the explicitly resumed launch conversation. No new model call.">
      Latest response · <time dateTime={new Date(session.contentObservedAt).toISOString()}>{new Date(session.contentObservedAt).toLocaleDateString()}</time>{" — "}
    </small>}
    <SessionMarkdown text={text} compact={compact} />
  </>;
}
