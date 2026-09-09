// The command palette rows and the header button live in different React
// trees. The request travels through this module's private scope, not the
// event's `detail`: bb loads every plugin bundle into one window, so a detail
// on a window event would let any page script trigger a fetch, pull or push.
// The window event only says "look at the pending request".
import type { QuickActionId } from "../shared/model";

export const OPEN_EVENT = "vcs-group:open";

export interface OpenRequest {
  threadId: string;
  /** Run this quick action once the popup has an overview and the row is enabled. */
  action?: QuickActionId;
}

let pending: OpenRequest | null = null;

export function requestOpen(request: OpenRequest): void {
  pending = request;
  try {
    window.dispatchEvent(new Event(OPEN_EVENT));
  } finally {
    // dispatchEvent is synchronous: a listener for this thread has taken it,
    // or nobody will.
    pending = null;
  }
}

/** Claims the pending request when it is for `threadId`; null otherwise. */
export function takeOpenRequest(threadId: string): OpenRequest | null {
  if (pending === null || pending.threadId !== threadId) return null;
  const request = pending;
  pending = null;
  return request;
}
