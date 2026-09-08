import { useEffect, useRef, useState, type FormEvent } from "react";
import { branchNameProblem } from "../shared/branch-name";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

interface NewBranchStepProps {
  /** Start point shown to the user; null means the current HEAD. */
  from: string | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; checkout: boolean }) => void;
}

export function NewBranchStep({ from, busy, onCancel, onCreate }: NewBranchStepProps) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const problem = branchNameProblem(name);
  const showProblem = name.length > 0 && problem !== null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem !== null || busy) return;
    onCreate({ name, checkout });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-3" aria-label="New branch">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="Plus" className="size-4" />
        New Branch
        <span className="text-xs font-normal text-muted-foreground">
          from {from ?? "current HEAD"}
        </span>
      </div>
      <Input
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Branch name"
        aria-label="New branch name"
        aria-invalid={showProblem}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <p className={showProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={showProblem ? "alert" : undefined}>
        {showProblem ? problem : "Letters, digits, '/', '.', '-' and '_'."}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={checkout} onCheckedChange={(value) => setCheckout(value === true)} />
        Checkout branch
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={problem !== null || busy}>
          Create
        </Button>
      </div>
    </form>
  );
}
