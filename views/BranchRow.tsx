import { Fragment, type MouseEvent } from "react";
import type { LocalBranch, Overview } from "../contracts";
import { entryKey, menuFor, type BranchEntry, type BranchMenuItemId, type TrackedOption } from "../shared/model";
import { CommandItem } from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type { BranchEntry } from "../shared/model";

/** Extra data a menu row carries: the chosen upstream of the Tracked Branch submenu. */
export interface MenuExtra {
  upstream?: TrackedOption["upstream"];
}

interface BranchRowProps {
  entry: BranchEntry;
  overview: Overview;
  /** cmdk value; unique per row. */
  value: string;
  disabled: boolean;
  favourite: boolean;
  onSelect: (entry: BranchEntry) => void;
  onMenu: (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => void;
}

/** Opens the row's context menu from the "..." button (keyboard and touch path). */
function openMenuAt(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget.closest("[cmdk-item]");
  if (!(row instanceof HTMLElement)) return;
  const rect = event.currentTarget.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }),
  );
}

export function BranchRow({ entry, overview, value, disabled, favourite, onSelect, onMenu }: BranchRowProps) {
  const items = menuFor(entry, overview, { favourite });
  const isCurrent = entry.kind === "local" && entry.branch.isCurrent;
  const name = entry.branch.name;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <CommandItem
          value={value}
          disabled={disabled}
          onSelect={() => onSelect(entry)}
          className="group gap-2 pr-1"
          data-branch-kind={entry.kind}
          data-branch-name={name}
          data-favourite={favourite ? "true" : undefined}
        >
          <Icon
            name={entry.kind === "local" ? "GitBranch" : "Cloud"}
            className={cn("size-3.5 shrink-0", isCurrent ? "text-foreground" : "text-muted-foreground")}
          />
          <span className={cn("min-w-0 flex-1 truncate", isCurrent && "font-medium")}>{name}</span>
          {isCurrent ? <Icon name="Check" className="size-3.5 shrink-0" aria-label="Current branch" /> : null}
          {entry.kind === "local" ? <TrackingBadge branch={entry.branch} /> : null}
          {entry.kind === "remote" && entry.branch.hasLocal ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">local</span>
          ) : null}
          <button
            type="button"
            aria-label={favourite ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
            aria-pressed={favourite}
            className={cn(
              "ml-1 rounded p-0.5 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100",
              favourite ? "text-foreground opacity-100" : "text-muted-foreground opacity-0",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onMenu("favourite", entry);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="Star" className={cn("size-3.5", favourite && "fill-current")} />
          </button>
          <button
            type="button"
            aria-label={`Actions for ${name}`}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100"
            onClick={openMenuAt}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="MoreHorizontal" className="size-3.5" />
          </button>
        </CommandItem>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-64" data-testid="vcs-branch-menu" data-branch-key={entryKey(entry)}>
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <ContextMenuSeparator /> : null}
            {item.id === "tracked-branch" ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger disabled={item.disabled} title={item.reason ?? undefined}>
                  {item.label}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="min-w-48">
                  {(item.children ?? []).map((option) => (
                    <ContextMenuItem
                      key={option.label}
                      onSelect={() => onMenu("tracked-branch", entry, { upstream: option.upstream })}
                      data-upstream={option.label}
                    >
                      <span className="flex-1">{option.label}</span>
                      {option.checked ? <Icon name="Check" className="size-3.5" aria-label="Tracked" /> : null}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : (
              <ContextMenuItem
                disabled={item.disabled}
                title={item.reason ?? undefined}
                onSelect={() => onMenu(item.id, entry)}
                data-menu-id={item.id}
              >
                {item.label}
                {item.hint ? <ContextMenuShortcut>{item.hint}</ContextMenuShortcut> : null}
              </ContextMenuItem>
            )}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TrackingBadge({ branch }: { branch: LocalBranch }) {
  if (branch.worktreePath !== null) {
    return (
      <span className="text-[10px] text-muted-foreground" title={`Checked out in ${branch.worktreePath}`}>
        worktree
      </span>
    );
  }
  if (branch.gone) {
    return <span className="text-[10px] text-muted-foreground">gone</span>;
  }
  if (branch.ahead === 0 && branch.behind === 0) return null;
  return (
    <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground" aria-label={`${branch.ahead} ahead, ${branch.behind} behind`}>
      {branch.ahead > 0 ? (
        <>
          <Icon name="ArrowUp" className="size-3" />
          {branch.ahead}
        </>
      ) : null}
      {branch.behind > 0 ? (
        <>
          <Icon name="ArrowDown" className="size-3" />
          {branch.behind}
        </>
      ) : null}
    </span>
  );
}
