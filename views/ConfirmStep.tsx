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
import { cn } from "@/lib/utils";

interface ConfirmStepProps {
  request: ConfirmRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Shows the exact git command before anything touches a remote or history. */
export function ConfirmStep({ request, onCancel, onConfirm }: ConfirmStepProps) {
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
          className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
        >
          {request?.command ?? ""}
        </pre>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(
              request?.tier === "destructive" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {request?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
