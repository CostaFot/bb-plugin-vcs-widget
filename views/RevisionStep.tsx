import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Tag, TagList } from "../contracts";
import { isValidRefish } from "../shared/branch-name";
import { matchScore } from "../shared/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

interface RevisionStepProps {
  busy: boolean;
  loadTags: () => Promise<TagList>;
  onCancel: () => void;
  onCheckout: (revision: string) => void;
}

const SHOWN_TAGS = 50;

/** IntelliJ's "Checkout Tag or Revision": type a revision or pick a tag. */
export function RevisionStep({ busy, loadTags, onCancel, onCheckout }: RevisionStepProps) {
  const [revision, setRevision] = useState("");
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = isValidRefish(revision.trim());

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    loadTags().then(
      (result) => {
        if (cancelled) return;
        if (result.ok) setTags(result.tags);
        else setTagsError(result.error.message);
      },
      () => {
        if (!cancelled) setTagsError("Could not list tags.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadTags]);

  const shown = useMemo(() => {
    if (tags === null) return [];
    const query = revision.trim();
    const ranked = query === "" ? tags : tags.filter((tag) => matchScore(tag.name, query) > 0);
    return ranked.slice(0, SHOWN_TAGS);
  }, [revision, tags]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || busy) return;
    onCheckout(revision.trim());
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-3" aria-label="Checkout tag or revision">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="Clock" className="size-4" />
        Checkout Tag or Revision
      </div>
      <Input
        ref={inputRef}
        value={revision}
        onChange={(event) => setRevision(event.target.value)}
        placeholder="Tag, sha, HEAD~2, …"
        aria-label="Tag or revision"
        aria-invalid={revision.length > 0 && !valid}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border" role="listbox" aria-label="Tags">
        {tags === null && tagsError === null ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Reading tags…</p>
        ) : tagsError !== null ? (
          <p className="px-2 py-1.5 text-xs text-destructive">{tagsError}</p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{tags?.length === 0 ? "No tags." : "No tag matches."}</p>
        ) : (
          shown.map((tag) => (
            <button
              key={tag.name}
              type="button"
              role="option"
              aria-selected={revision.trim() === tag.name}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => setRevision(tag.name)}
              data-tag={tag.name}
            >
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
              <span className="truncate text-xs text-muted-foreground">{tag.subject}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{tag.sha}</span>
            </button>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">Checks out the commit with a detached HEAD.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          Checkout
        </Button>
      </div>
    </form>
  );
}
