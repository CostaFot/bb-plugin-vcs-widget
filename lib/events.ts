// The command palette rows and the header button live in different React
// trees, so a window event carries "open the popup for this thread".
import type { QuickActionId } from "../shared/model";

export const OPEN_EVENT = "vcs-group:open";

export interface OpenEventDetail {
  threadId: string;
  /** Run this quick action as soon as the popup has an overview. */
  action?: QuickActionId;
}

export function requestOpen(detail: OpenEventDetail): void {
  window.dispatchEvent(new CustomEvent<OpenEventDetail>(OPEN_EVENT, { detail }));
}

export function isOpenEventDetail(value: unknown): value is OpenEventDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { threadId?: unknown }).threadId === "string"
  );
}
