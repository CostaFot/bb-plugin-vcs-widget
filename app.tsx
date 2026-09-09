// VCS Widget frontend: a branch button in every thread header that opens the
// Git branches popup, command palette rows that open it or run one of its
// quick actions, four side-panel tabs (compare branches and diff with the
// working tree from the context menu, the commit dialog and the log), and two
// blocks on the plugin's settings page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { requestOpen } from "./lib/events";
import type { QuickActionId } from "./shared/model";
import { PANEL_ACTION } from "./shared/panel-params";
import { BranchButton } from "./views/BranchButton";
import { CommitPanel } from "./views/CommitPanel";
import { LogPanel } from "./views/LogPanel";
import { ComparePanel, DiffPanel } from "./views/panels";
import { AgentAccessSection, FavouritesSection } from "./views/SettingsSections";
import "./app.css";

const PALETTE_ROWS: { id: string; title: string; action: QuickActionId | null }[] = [
  { id: "open-branches", title: "VCS Widget: Open branches", action: null },
  { id: "update-project", title: "VCS Widget: Update Project", action: "update" },
  { id: "commit", title: "VCS Widget: Commit...", action: "commit" },
  { id: "log", title: "VCS Widget: Show Git Log", action: "log" },
  { id: "fetch", title: "VCS Widget: Fetch", action: "fetch" },
  { id: "push", title: "VCS Widget: Push...", action: "push" },
  { id: "new-branch", title: "VCS Widget: New Branch...", action: "new-branch" },
  { id: "checkout-revision", title: "VCS Widget: Checkout Tag or Revision...", action: "checkout-revision" },
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

  app.slots.settingsSection({
    id: "agent-access",
    title: "Agent access",
    description: "What this plugin exposes to agents and to a terminal.",
    component: AgentAccessSection,
  });

  app.slots.settingsSection({
    id: "favourites",
    title: "Favourite branches",
    description: "Starred branches, kept per machine and worktree rather than per thread.",
    component: FavouritesSection,
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
