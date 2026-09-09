// VCS Group frontend: a branch button in every thread header that opens the
// Git branches popup, command palette rows that open it or run one of its
// quick actions, and four side-panel tabs: compare branches and diff with
// the working tree (from the context menu), the commit dialog and the log.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { requestOpen } from "./lib/events";
import type { QuickActionId } from "./shared/model";
import { PANEL_ACTION } from "./shared/panel-params";
import { BranchButton } from "./views/BranchButton";
import { CommitPanel } from "./views/CommitPanel";
import { LogPanel } from "./views/LogPanel";
import { ComparePanel, DiffPanel } from "./views/panels";
import "./app.css";

const PALETTE_ROWS: { id: string; title: string; action: QuickActionId | null }[] = [
  { id: "open-branches", title: "VCS Group: Open branches", action: null },
  { id: "update-project", title: "VCS Group: Update Project", action: "update" },
  { id: "commit", title: "VCS Group: Commit...", action: "commit" },
  { id: "log", title: "VCS Group: Show Git Log", action: "log" },
  { id: "fetch", title: "VCS Group: Fetch", action: "fetch" },
  { id: "push", title: "VCS Group: Push...", action: "push" },
  { id: "new-branch", title: "VCS Group: New Branch...", action: "new-branch" },
  { id: "checkout-revision", title: "VCS Group: Checkout Tag or Revision...", action: "checkout-revision" },
];

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "branches",
    title: "Git branches",
    component: BranchButton,
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION.compare,
    title: "Compare branches",
    icon: "GitMerge",
    component: ComparePanel,
    layout: "flush",
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION.diff,
    title: "Diff with working tree",
    icon: "FileDiff",
    component: DiffPanel,
    layout: "flush",
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION.commit,
    title: "Commit",
    icon: "Check",
    component: CommitPanel,
    layout: "flush",
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION.log,
    title: "Git Log",
    icon: "Clock",
    component: LogPanel,
    layout: "flush",
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
