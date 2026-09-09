// One row of the log: the ref badges the commit carries, its subject, author
// and date, and the per-commit context menu. The row is a fixed height so the
// list above it can be virtualised without measuring anything.
import { Fragment, type MouseEvent } from "react";
import type { LogCommit, Overview, RefBadge, ResetMode } from "../contracts";
import { LOG_ROW_HEIGHT } from "../shared/constants";
import { commitMenuFor, type CommitMenuItemId } from "../shared/model";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Extra data a menu row carries: the mode of the Reset submenu. */
export interface CommitMenuExtra {
  mode?: ResetMode;
}

const BADGE_CLASS: Record<RefBadge["kind"], string> = {
  head: "border-foreground/40 text-foreground",
  local: "border-green-600/50 text-green-700 dark:border-green-400/50 dark:text-green-400",
  remote: "border-blue-600/50 text-blue-700 dark:border-blue-400/50 dark:text-blue-400",
  tag: "border-amber-600/50 text-amber-700 dark:border-amber-400/50 dark:text-amber-400",
  other: "border-border text-muted-foreground",
};

function formatWhen(unix: number): string {
  if (unix <= 0) return "";
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Opens the row's context menu from the "..." button (keyboard and touch path). */
function openMenuAt(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget.closest("[data-sha]");
  if (!(row instanceof HTMLElement)) return;
  const rect = event.currentTarget.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
}

interface CommitRowProps {
  commit: LogCommit;
  overview: Overview | null;
  selected: boolean;
  onSelect: (commit: LogCommit) => void;
  onMenu: (itemId: CommitMenuItemId, commit: LogCommit, extra?: CommitMenuExtra) => void;
}

export function CommitRow({ commit, overview, selected, onSelect, onMenu }: CommitRowProps) {
  const items = overview === null ? [] : commitMenuFor(commit, overview);
  const row = (
    <div
      className={cn("group flex items-center gap-2 px-2 text-xs hover:bg-accent", selected && "bg-accent")}
      style={{ height: LOG_ROW_HEIGHT }}
      data-sha={commit.sha}
      data-selected={selected ? "true" : undefined}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        aria-pressed={selected}
        onClick={() => onSelect(commit)}
        title={`${commit.sha}\n${commit.subject}`}
      >
        {commit.parents.length > 1 ? (
          <Icon name="GitMerge" className="size-3 shrink-0 text-muted-foreground" aria-label="Merge commit" />
        ) : null}
        {commit.refs.map((badge) => (
          <span
            key={`${badge.kind}:${badge.name}`}
            className={cn("shrink-0 rounded border px-1 text-[10px] leading-4", BADGE_CLASS[badge.kind])}
            data-ref-kind={badge.kind}
          >
            {badge.name}
          </span>
        ))}
        <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
        <span className="shrink-0 truncate text-muted-foreground" style={{ maxWidth: "8rem" }}>
          {commit.author}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatWhen(commit.committedAt)}</span>
        <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
      </button>
      <button
        type="button"
        aria-label={`Actions for ${commit.shortSha}`}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={openMenuAt}
      >
        <Icon name="MoreHorizontal" className="size-3.5" />
      </button>
    </div>
  );

  if (overview === null) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-64" data-testid="vcs-commit-menu" data-sha={commit.sha}>
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <ContextMenuSeparator /> : null}
            {item.id === "reset" ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger disabled={item.disabled} title={item.reason ?? undefined} data-menu-id={item.id}>
                  {item.label}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="min-w-48">
                  {(item.children ?? []).map((option) => (
                    <ContextMenuItem
                      key={option.mode}
                      title={option.description}
                      onSelect={() => onMenu("reset", commit, { mode: option.mode })}
                      data-reset-mode={option.mode}
                    >
                      {option.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : (
              <ContextMenuItem
                disabled={item.disabled}
                title={item.reason ?? undefined}
                onSelect={() => onMenu(item.id, commit)}
                data-menu-id={item.id}
              >
                {item.label}
              </ContextMenuItem>
            )}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
