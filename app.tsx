// VCS Group frontend: a branch button in every thread header that opens the
// Git branches popup, plus command palette rows that open it or run one of
// its quick actions.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { requestOpen } from "./lib/events";
import type { QuickActionId } from "./shared/model";
import { BranchButton } from "./views/BranchButton";
import "./app.css";

const PALETTE_ROWS: { id: string; title: string; action: QuickActionId | null }[] = [
  { id: "open-branches", title: "VCS Group: Open branches", action: null },
  { id: "update-project", title: "VCS Group: Update Project", action: "update" },
  { id: "fetch", title: "VCS Group: Fetch", action: "fetch" },
  { id: "push", title: "VCS Group: Push...", action: "push" },
  { id: "new-branch", title: "VCS Group: New Branch...", action: "new-branch" },
];

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "branches",
    title: "Git branches",
    component: BranchButton,
  });

  for (const row of PALETTE_ROWS) {
    app.slots.commandPaletteAction({
      id: row.id,
      title: row.title,
      isAvailable: ({ threadId }) => threadId !== null,
      run: ({ threadId }) => {
        if (threadId === null) return;
        requestOpen(row.action === null ? { threadId } : { threadId, action: row.action });
      },
    });
  }
});
