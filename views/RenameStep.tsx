import { useEffect, useRef, useState, type FormEvent } from "react";
import { branchNameProblem } from "../shared/branch-name";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

interface RenameStepProps {
  from: string;
  busy: boolean;
  onCancel: () => void;
  onRename: (to: string) => void;
}

export function RenameStep({ from, busy, onCancel, onRename }: RenameStepProps) {
  const [name, setName] = useState(from);
  const inputRef = useRef<HTMLInputElement>(null);
  const problem = branchNameProblem(name);
  const unchanged = name === from;
  const showProblem = name.length > 0 && problem !== null;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem !== null || unchanged || busy) return;
    onRename(name);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-3" aria-label="Rename branch">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="Edit" className="size-4" />
        Rename Branch
        <span className="truncate text-xs font-normal text-muted-foreground">{from}</span>
      </div>
      <Input
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="New branch name"
        aria-label="New name"
        aria-invalid={showProblem}
        autoComplete="off"
        spellCheck={false}
      />
      <p className={showProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={showProblem ? "alert" : undefined}>
        {showProblem ? problem : "The branch keeps its upstream and reflog."}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={problem !== null || unchanged || busy}>
          Rename
        </Button>
      </div>
    </form>
  );
}
