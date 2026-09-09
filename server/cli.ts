// The read-only surfaces: the `bb vcs-widget` command and the
// `vcs_widget_status` agent tool. Both parse here, read through the same two
// host reads (overview and log) and render the same text, so an agent sees
// exactly what a human at a terminal sees.
//
// Nothing in this module mutates a repository, and it must stay that way: it
// is the one part of the plugin an agent can reach without a browser, and the
// safety promise in the README is that no agent-callable surface can change
// git state. It therefore never names a mutating host method.
import type { PluginCliCommandInfo, PluginCliResult } from "@get-bb/plugin-sdk";
import type { LocalBranch, LogCommit, LogFilter, LogPage, Overview, RemoteBranch } from "../contracts";
import { isValidGitBranchName } from "../shared/branch-name";
import { LOG_PAGE_SIZE, MAX_LOG_GREP_LENGTH } from "../shared/constants";

export const CLI_NAME = "vcs-widget";

/** Branch rows one `branches` call prints; well inside the 1 MiB CLI cap. */
const BRANCH_LIMIT = { default: 50, max: 500 } as const;
const LOG_LIMIT = { default: 20, max: LOG_PAGE_SIZE } as const;
/** A subject longer than this is elided in the text output; --json keeps it. */
const SUBJECT_WIDTH = 72;
/** Longest branch-name column before the remaining fields stop being aligned. */
const NAME_COLUMN_MAX = 40;

export type BranchScope = "local" | "remote" | "all";

export type CliCommand =
  | { kind: "help" }
  | { kind: "status"; threadId: string | null; json: boolean }
  | { kind: "branches"; threadId: string | null; json: boolean; scope: BranchScope; limit: number }
  | { kind: "log"; threadId: string | null; json: boolean; filter: LogFilter; grep: string | null; limit: number };

export type CliParse = { ok: true; command: CliCommand } | { ok: false; message: string };

export const CLI_COMMANDS: PluginCliCommandInfo[] = [
  {
    name: "status",
    summary: "Current branch, upstream, working tree and any running git job (read-only).",
    usage: `bb ${CLI_NAME} status [--thread <id>] [--json]`,
  },
  {
    name: "branches",
    summary: "Local and remote branches with ahead/behind and upstream (read-only).",
    usage: `bb ${CLI_NAME} branches [--remote | --all] [--limit <n>] [--thread <id>] [--json]`,
  },
  {
    name: "log",
    summary: "Recent commits on the current branch, one branch or all branches (read-only).",
    usage: `bb ${CLI_NAME} log [--branch <name> | --all] [--grep <text>] [--limit <n>] [--thread <id>] [--json]`,
  },
];

export const CLI_SUMMARY = "Read the git state of a bb thread's worktree (read-only; it never changes a repository).";

export const CLI_HELP = [
  `bb ${CLI_NAME} — ${CLI_SUMMARY}`,
  "",
  "Commands:",
  ...CLI_COMMANDS.map((command) => `  ${command.usage}`),
  "",
  "Options:",
  "  --thread <id>   Thread whose worktree to read; defaults to the calling thread.",
  "  --json          Print the data instead of the table.",
  "  --limit <n>     Rows to print (branches: 50, max 500; log: 20, max 100).",
  "  --remote/--all  branches: remote branches only, or both lists.",
  "  --branch <name> log: walk one local branch instead of the current one.",
  "  --all           log: walk every local and remote branch.",
  "  --grep <text>   log: literal substring of the commit message, never a regex.",
  "",
  "Every command reads. Checkout, commit, push and the rest of the plugin are",
  "the human's to run from the branch popup, the commit panel or the log.",
].join("\n");

// ---------------------------------------------------------------------------
// Parsing: argv arrives from a shell, so every value is untrusted.
// ---------------------------------------------------------------------------

interface Flags {
  thread: string | null;
  json: boolean;
  limit: number | null;
  remote: boolean;
  all: boolean;
  branch: string | null;
  grep: string | null;
}

const FLAGS_WITH_VALUE = new Set(["--thread", "--limit", "--branch", "--grep"]);

function parseFlags(argv: readonly string[], allowed: ReadonlySet<string>): { ok: true; flags: Flags } | { ok: false; message: string } {
  const flags: Flags = { thread: null, json: false, limit: null, remote: false, all: false, branch: null, grep: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) return { ok: false, message: `Unexpected argument "${token}".` };
    if (!allowed.has(token)) return { ok: false, message: `Unknown option "${token}".` };
    if (!FLAGS_WITH_VALUE.has(token)) {
      if (token === "--json") flags.json = true;
      if (token === "--remote") flags.remote = true;
      if (token === "--all") flags.all = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${token} needs a value.` };
    index += 1;
    if (token === "--thread") flags.thread = value;
    if (token === "--branch") flags.branch = value;
    if (token === "--grep") flags.grep = value;
    if (token === "--limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) return { ok: false, message: `--limit needs a whole number of rows, not "${value}".` };
      flags.limit = limit;
    }
  }
  return { ok: true, flags };
}

function clamp(value: number | null, bounds: { default: number; max: number }): number {
  if (value === null) return bounds.default;
  return Math.min(value, bounds.max);
}

export function parseCli(argv: readonly string[]): CliParse {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") return { ok: true, command: { kind: "help" } };

  if (name === "status") {
    const parsed = parseFlags(rest, new Set(["--thread", "--json"]));
    if (!parsed.ok) return parsed;
    return { ok: true, command: { kind: "status", threadId: parsed.flags.thread, json: parsed.flags.json } };
  }

  if (name === "branches") {
    const parsed = parseFlags(rest, new Set(["--thread", "--json", "--limit", "--remote", "--all"]));
    if (!parsed.ok) return parsed;
    const { flags } = parsed;
    if (flags.remote && flags.all) return { ok: false, message: "Use --remote or --all, not both." };
    const scope: BranchScope = flags.all ? "all" : flags.remote ? "remote" : "local";
    return {
      ok: true,
      command: { kind: "branches", threadId: flags.thread, json: flags.json, scope, limit: clamp(flags.limit, BRANCH_LIMIT) },
    };
  }

  if (name === "log") {
    const parsed = parseFlags(rest, new Set(["--thread", "--json", "--limit", "--branch", "--all", "--grep"]));
    if (!parsed.ok) return parsed;
    const { flags } = parsed;
    if (flags.branch !== null && flags.all) return { ok: false, message: "Use --branch or --all, not both." };
    if (flags.branch !== null && !isValidGitBranchName(flags.branch)) {
      return { ok: false, message: `"${flags.branch}" is not a valid git branch name.` };
    }
    if (flags.grep !== null) {
      if (flags.grep.length === 0) return { ok: false, message: "--grep needs some text." };
      if (flags.grep.length > MAX_LOG_GREP_LENGTH) return { ok: false, message: `--grep takes at most ${MAX_LOG_GREP_LENGTH} characters.` };
      if (flags.grep.includes("\n") || flags.grep.includes("\0")) return { ok: false, message: "--grep cannot contain newlines." };
    }
    const filter: LogFilter = flags.all
      ? { kind: "all" }
      : flags.branch === null
        ? { kind: "head" }
        : { kind: "ref", ref: { kind: "local", name: flags.branch } };
    return {
      ok: true,
      command: { kind: "log", threadId: flags.thread, json: flags.json, filter, grep: flags.grep, limit: clamp(flags.limit, LOG_LIMIT) },
    };
  }

  return { ok: false, message: `Unknown command "${name}".` };
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function elide(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** UTC so the same repository reads the same from any machine and in tests. */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function headLine(head: Overview["head"]): string {
  if (head === null) return "unknown";
  if (head.kind === "branch") return `${head.name} (${head.sha.slice(0, 7)})`;
  if (head.kind === "detached") return `detached at ${head.sha.slice(0, 7)}`;
  return `${head.name} (no commits yet)`;
}

function upstreamLine(upstream: Overview["upstream"]): string {
  if (upstream === null) return "none";
  const state = upstream.gone ? "gone from the remote" : `ahead ${upstream.ahead}, behind ${upstream.behind}`;
  return `${upstream.name} (${state})`;
}

function workingTreeLine(tree: Overview["workingTree"]): string {
  const parts = [
    tree.staged > 0 ? `${tree.staged} staged` : null,
    tree.unstaged > 0 ? `${tree.unstaged} unstaged` : null,
    tree.untracked > 0 ? `${tree.untracked} untracked` : null,
    tree.conflicted > 0 ? `${tree.conflicted} conflicted` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "clean" : parts.join(", ");
}

function row(label: string, value: string): string {
  return `${pad(`${label}:`, 12)}${value}`;
}

export function formatStatus(overview: Overview): string {
  if (overview.unavailableReason !== null) return overview.unavailableReason;
  const lines = [
    row("Repository", `${overview.repoName ?? "?"} (${overview.repoRoot ?? "?"})`),
    row("HEAD", headLine(overview.head)),
    row("Upstream", upstreamLine(overview.upstream)),
    row("Working", workingTreeLine(overview.workingTree)),
  ];
  if (overview.operation !== "none") lines.push(row("Operation", `${overview.operation} in progress`));
  if (overview.indexLocked) lines.push(row("Index", "locked (.git/index.lock exists)"));
  if (overview.activeJob !== null) {
    lines.push(row("Job", `${overview.activeJob.kind} since ${formatTimestamp(overview.activeJob.startedAt)} — ${overview.activeJob.command}`));
  }
  lines.push(
    row(
      "Branches",
      `${overview.local.length}${overview.truncated.local ? "+" : ""} local, ${overview.remote.length}${overview.truncated.remote ? "+" : ""} remote`,
    ),
  );
  if (overview.remotes.length > 0) lines.push(row("Remotes", overview.remotes.join(", ")));
  if (overview.gitVersion !== null) lines.push(row("Git", overview.gitVersion));
  return lines.join("\n");
}

function localBranchLine(branch: LocalBranch, width: number): string {
  const marker = branch.isCurrent ? "*" : " ";
  const tracking =
    branch.upstream === null
      ? "no upstream"
      : branch.gone
        ? `${branch.upstream} (gone)`
        : `${branch.upstream} +${branch.ahead}/-${branch.behind}`;
  const worktree = branch.worktreePath !== null && !branch.isCurrent ? `  [worktree ${branch.worktreePath}]` : "";
  return `${marker} ${pad(elide(branch.name, width), width)}  ${branch.sha.slice(0, 7)}  ${pad(tracking, 28)}  ${elide(branch.subject, SUBJECT_WIDTH)}${worktree}`.trimEnd();
}

function remoteBranchLine(branch: RemoteBranch, width: number): string {
  const local = branch.hasLocal ? "has a local branch" : "";
  return `  ${pad(elide(branch.name, width), width)}  ${branch.sha.slice(0, 7)}  ${pad(local, 28)}  ${elide(branch.subject, SUBJECT_WIDTH)}`.trimEnd();
}

function columnWidth(names: readonly string[]): number {
  return Math.min(NAME_COLUMN_MAX, Math.max(8, ...names.map((name) => name.length)));
}

function omittedLine(shown: number, total: number, truncated: boolean): string | null {
  const omitted = total - shown;
  if (omitted <= 0) return truncated ? "  … more branches exist than the host reads in one pass." : null;
  return `  … ${omitted} more (use --limit).`;
}

export function formatBranches(overview: Overview, scope: BranchScope, limit: number): string {
  if (overview.unavailableReason !== null) return overview.unavailableReason;
  const blocks: string[] = [];
  if (scope !== "remote") {
    const shown = overview.local.slice(0, limit);
    const width = columnWidth(shown.map((branch) => branch.name));
    const lines = [`Local branches (${overview.local.length}${overview.truncated.local ? "+" : ""})`];
    if (shown.length === 0) lines.push("  none");
    else lines.push(...shown.map((branch) => localBranchLine(branch, width)));
    const more = omittedLine(shown.length, overview.local.length, overview.truncated.local);
    if (more !== null) lines.push(more);
    blocks.push(lines.join("\n"));
  }
  if (scope !== "local") {
    const shown = overview.remote.slice(0, limit);
    const width = columnWidth(shown.map((branch) => branch.name));
    const lines = [`Remote branches (${overview.remote.length}${overview.truncated.remote ? "+" : ""})`];
    if (shown.length === 0) lines.push("  none");
    else lines.push(...shown.map((branch) => remoteBranchLine(branch, width)));
    const more = omittedLine(shown.length, overview.remote.length, overview.truncated.remote);
    if (more !== null) lines.push(more);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function refsLabel(commit: LogCommit): string {
  if (commit.refs.length === 0) return "";
  return `  (${commit.refs.map((ref) => ref.name).join(", ")})`;
}

export function formatLog(commits: readonly LogCommit[], hasMore: boolean): string {
  if (commits.length === 0) return "No commits.";
  const authorWidth = Math.min(24, Math.max(6, ...commits.map((commit) => commit.author.length)));
  const lines = commits.map(
    (commit) =>
      `${commit.shortSha}  ${formatTimestamp(commit.committedAt)}  ${pad(elide(commit.author, authorWidth), authorWidth)}  ${elide(commit.subject, SUBJECT_WIDTH)}${refsLabel(commit)}`,
  );
  if (hasMore) lines.push("… more commits (use --limit, or --grep to narrow).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON output: the same reads, capped the same way, so neither shape can grow
// past the CLI's output limit on a repository with thousands of branches.
// ---------------------------------------------------------------------------

export function statusJson(overview: Overview): unknown {
  const { local, remote, truncated, ...rest } = overview;
  return { ...rest, branchCounts: { local: local.length, remote: remote.length, truncated } };
}

export function branchesJson(overview: Overview, scope: BranchScope, limit: number): unknown {
  return {
    local: scope === "remote" ? [] : overview.local.slice(0, limit),
    remote: scope === "local" ? [] : overview.remote.slice(0, limit),
    counts: { local: overview.local.length, remote: overview.remote.length },
    truncated: overview.truncated,
  };
}

// ---------------------------------------------------------------------------
// Running a parsed command against the two reads.
// ---------------------------------------------------------------------------

export interface CliReader {
  overview(threadId: string): Promise<Overview>;
  log(threadId: string, input: { filter: LogFilter; grep: string | null; skip: number }): Promise<LogPage>;
}

const usage = (message: string): PluginCliResult => ({ exitCode: 2, stderr: `${message}\n\n${CLI_HELP}\n` });
const failed = (message: string): PluginCliResult => ({ exitCode: 1, stderr: `${message}\n` });
const printed = (text: string): PluginCliResult => ({ exitCode: 0, stdout: `${text}\n` });

/**
 * Runs a parsed command. `threadId` is resolved by the caller: the CLI takes
 * it from `--thread` or the invoking thread, the agent tool from its own
 * call context. It is never a path, so nothing here touches a filesystem —
 * the reads all run on the host that owns the worktree.
 */
export async function runCommand(command: CliCommand, threadId: string, reader: CliReader): Promise<PluginCliResult> {
  try {
    return await read(command, threadId, reader);
  } catch (cause) {
    // A thread id that names nothing, an unreachable host, a torn-down call:
    // an exit code and a sentence, never a stack out of the plugin.
    return failed(`Could not read the repository: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function read(command: CliCommand, threadId: string, reader: CliReader): Promise<PluginCliResult> {
  if (command.kind === "help") return printed(CLI_HELP);

  if (command.kind === "log") {
    const page = await reader.log(threadId, { filter: command.filter, grep: command.grep, skip: 0 });
    if (!page.ok) return failed(`${page.error.message}${page.error.hint === undefined ? "" : `\n${page.error.hint}`}`);
    const commits = page.commits.slice(0, command.limit);
    const hasMore = page.hasMore || commits.length < page.commits.length;
    if (command.json) return printed(JSON.stringify({ commits, hasMore }, null, 2));
    return printed(formatLog(commits, hasMore));
  }

  const overview = await reader.overview(threadId);
  if (overview.unavailableReason !== null) return failed(overview.unavailableReason);
  if (command.kind === "status") {
    return printed(command.json ? JSON.stringify(statusJson(overview), null, 2) : formatStatus(overview));
  }
  return printed(
    command.json
      ? JSON.stringify(branchesJson(overview, command.scope, command.limit), null, 2)
      : formatBranches(overview, command.scope, command.limit),
  );
}

/** The `bb vcs-widget` entry point: parse, resolve the thread, run. */
export async function runCli(argv: readonly string[], threadId: string | undefined, reader: CliReader): Promise<PluginCliResult> {
  const parsed = parseCli(argv);
  if (!parsed.ok) return usage(parsed.message);
  const command = parsed.command;
  if (command.kind === "help") return printed(CLI_HELP);
  const target = command.threadId ?? threadId ?? null;
  if (target === null) {
    return usage("No thread to read. Run this from a bb thread, or name one with --thread <id>.");
  }
  return runCommand(command, target, reader);
}
