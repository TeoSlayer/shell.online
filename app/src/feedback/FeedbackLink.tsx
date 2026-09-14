import type { ReactNode } from "react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useFeedback, type FeedbackRequest } from "./context";

interface FeedbackLinkProps extends FeedbackRequest {
  children?: ReactNode;
  className?: string;
}

/**
 * The line that opens the feedback sheet, from wherever something might have
 * gone wrong. Quiet on purpose: it sits under a form or a notice and must not
 * compete with the action the person came for.
 */
export function FeedbackLink({
  children = "Something off? Tell us",
  className,
  ...request
}: FeedbackLinkProps) {
  const { open } = useFeedback();
  return (
    <button
      type="button"
      className={className ? `feedback-link ${className}` : "feedback-link"}
      onClick={() => open(request)}
    >
      <ChatCircleDots size={14} />
      <span>{children}</span>
    </button>
  );
}
