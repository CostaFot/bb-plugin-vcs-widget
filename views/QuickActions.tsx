import type { Overview } from "../contracts";
import { matchScore, quickActionsFor, type QuickActionId } from "../shared/model";
import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";
import { Icon, type IconName } from "@/components/ui/icon";

const ICONS: Record<QuickActionId, IconName> = {
  update: "ArrowDown",
  fetch: "ArrowReloadHorizontal",
  push: "ArrowUp",
  "new-branch": "Plus",
};

interface QuickActionsProps {
  overview: Overview | null;
  query: string;
  busy: boolean;
  onAction: (id: QuickActionId) => void;
}

export function QuickActions({ overview, query, busy, onAction }: QuickActionsProps) {
  if (overview === null) return null;
  const actions = quickActionsFor(overview).filter((action) => matchScore(action.label, query) > 0);
  if (actions.length === 0) return null;
  return (
    <CommandGroup heading="Actions">
      {actions.map((action) => (
        <CommandItem
          key={action.id}
          value={`action:${action.id}`}
          disabled={busy || action.disabled}
          onSelect={() => onAction(action.id)}
          title={action.reason ?? undefined}
          data-action={action.id}
        >
          <Icon name={ICONS[action.id]} className="size-3.5 text-muted-foreground" />
          <span className="flex-1 truncate">{action.label}</span>
          {action.hint ? <CommandShortcut>{action.hint}</CommandShortcut> : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
