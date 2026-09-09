import { useEffect, useState } from "react";
import type { ConfirmRequest } from "../hooks/use-vcs-actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface ConfirmStepProps {
  request: ConfirmRequest | null;
  onCancel: () => void;
  onConfirm: (toggled: boolean) => void;
}

/** Shows the exact git command before anything touches a remote or history. */
export function ConfirmStep({ request, onCancel, onConfirm }: ConfirmStepProps) {
  const [toggled, setToggled] = useState(false);
  // A new request starts with the switch off, whatever the last one did.
  useEffect(() => {
    setToggled(false);
  }, [request]);
  const active = toggled && request?.toggle ? request.toggle : null;
  const tier = active?.tier ?? request?.tier;
  const command = active?.command ?? request?.command ?? "";

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description ?? ""}</AlertDialogDescription>
        </AlertDialogHeader>
        <pre
          data-testid="vcs-command-preview"
          className="overflow-x-auto whitespace-pre rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
        >
          {command}
        </pre>
        {request?.toggle ? (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={toggled}
              onCheckedChange={(value) => setToggled(value === true)}
              aria-label={request.toggle.label}
              data-testid="vcs-confirm-toggle"
            />
            <span>{request.toggle.label}</span>
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(toggled)}
            className={cn(tier === "destructive" && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
          >
            {request?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
