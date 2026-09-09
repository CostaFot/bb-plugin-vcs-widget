import { describe, expect, it } from "vitest";
import { classifyGitFailure, firstStderrLine, pluginGitError } from "./git-errors";

describe("classifyGitFailure", () => {
  it.each([
    ["index_locked", "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running"],
    ["operation_in_progress", "fatal: You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge."],
    ["dirty_worktree", "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches."],
    ["conflict", "CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result."],
    ["ref_exists", "fatal: a branch named 'feature' already exists"],
    ["invalid_ref_name", "fatal: 'bad name' is not a valid branch name"],
    ["ref_not_found", "error: pathspec 'nope' did not match any file(s) known to git"],
    ["ref_not_found", "fatal: invalid reference: nope"],
    ["ref_not_found", "warning: refname 'origin/main' is ambiguous.\nfatal: ambiguous object name: 'origin/main'"],
    ["no_upstream", "Your configuration specifies to merge with the ref 'refs/heads/gone' from the remote, but no such ref was fetched."],
    ["no_upstream", "fatal: The current branch feat has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin feat"],
    ["no_upstream", "There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against."],
    ["no_remote", "fatal: 'upstream' does not appear to be a git repository\nfatal: Could not read from remote repository."],
    ["auth_required", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ["auth_required", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."],
    ["network", "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"],
    ["non_fast_forward", "To github.com:x/y.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:x/y.git'"],
    ["non_fast_forward", "fatal: Not possible to fast-forward, aborting."],
    ["detached_head", "fatal: You are not currently on a branch.\nPlease specify which branch you want to merge with."],
    ["not_a_repo", "fatal: not a git repository (or any of the parent directories): .git"],
    ["git_failed", "fatal: something entirely unexpected happened"],
  ] as const)("classifies %s", (code, stderr) => {
    const result = classifyGitFailure({ phase: "push", exitCode: 128, stderr });
    expect(result.code).toBe(code);
    expect(result.message).toMatch(/^Push failed/u);
    expect(result.stderr).toBe(stderr);
  });

  it("reports timeouts and cancellations before reading stderr", () => {
    expect(classifyGitFailure({ phase: "fetch", exitCode: null, stderr: "", timedOut: true, deadlineSeconds: 25 })).toMatchObject({
      code: "timeout",
      message: "Fetch took longer than 25 s and was stopped.",
    });
    expect(classifyGitFailure({ phase: "pull", exitCode: null, stderr: "", cancelled: true })).toMatchObject({
      code: "cancelled",
    });
  });

  it("uses phase-specific hints", () => {
    expect(classifyGitFailure({ phase: "pull", exitCode: 1, stderr: "fatal: Not possible to fast-forward, aborting." }).hint).toMatch(/rebase or merge/u);
    expect(classifyGitFailure({ phase: "push", exitCode: 1, stderr: " ! [rejected] main -> main (non-fast-forward)" }).hint).toMatch(/Update Project first/u);
  });

  it("falls back to the exit code when stderr is empty", () => {
    expect(classifyGitFailure({ phase: "checkout", exitCode: 3, stderr: "" })).toMatchObject({
      code: "git_failed",
      message: "Checkout failed (exit 3).",
    });
  });
});

describe("firstStderrLine", () => {
  it("skips hints and strips the fatal prefix", () => {
    expect(firstStderrLine("hint: use --force\nfatal: real problem\nmore")).toBe("real problem");
    expect(firstStderrLine("")).toBe("");
  });
  it("prefers the rejection reason over push's 'To <url>' line", () => {
    expect(firstStderrLine("To ../o.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to '../o.git'")).toBe(
      "[rejected]        HEAD -> main (fetch first)",
    );
    expect(firstStderrLine("To ../o.git")).toBe("To ../o.git");
  });
});

describe("pluginGitError", () => {
  it("attaches the default hint for the code", () => {
    expect(pluginGitError("busy", "Busy.", "checkout")).toEqual({
      code: "busy",
      message: "Busy.",
      hint: "Another VCS action on this repository is still running.",
    });
    expect(pluginGitError("head_changed", "Moved.", "push").hint).toMatch(/Open it again/u);
  });
});
