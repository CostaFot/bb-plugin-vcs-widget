// Headless click-through of the milestone 3 commit dialog against a running
// bb: the Commit quick action and palette row, the file list with staged
// checkboxes, the diff preview with its Staged / Unstaged switch, commit,
// amend, discard per category, Commit and Push, hooks as a background job,
// and live refresh after a terminal `git add`.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m3.mjs /tmp/vcs-scratch
//
// See docs/VERIFY.md. Needs system Chromium and puppeteer-core in node_modules.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GIT_ID, browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m3.mjs <repo path>");
  process.exit(2);
}
const BARE = `${REPO}.git`;
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const NEW = `new-${TS}.txt`;
const JUNK = `junk-${TS}.txt`;
const MSG = `Panel commit ${TS}`;
const AMENDED = `Amended ${TS}`;
const PUSHED = `Pushed ${TS}`;
const HOOKS = `${REPO}-hooks-${TS}`;
const PANEL = '[data-testid="vcs-commit-panel"]';
const head = () => sh(`git -C ${REPO} rev-parse HEAD`);
const subject = () => sh(`git -C ${REPO} log -1 --format=%s`);
const status = (path) => sh(`git -C ${REPO} status --porcelain=v2 -- "${path}"`).slice(2, 4);

sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} clean -fdq`);
sh(`git -C ${REPO} config --unset core.hooksPath`);

const a = await H.launch("m3");
const page = a.page;

const panelText = async () => (await page.$eval(PANEL, (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
const waitPanel = async (re, ms = 15_000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await panelText();
    if (re.test(last)) return last;
    await sleep(300);
  }
  return `TIMEOUT last="${last.slice(0, 300)}"`;
};
const checkbox = (label) => page.$eval(`${PANEL} [aria-label="${label}"]`, (e) => e.getAttribute("aria-checked")).catch(() => null);
const waitCheckbox = async (label, want, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await checkbox(label)) === want) return true;
    await sleep(300);
  }
  return false;
};
const typeMessage = async (text) => {
  await page.click(`${PANEL} [data-testid="vcs-commit-message"]`);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
};
const messageValue = () => page.$eval(`${PANEL} [data-testid="vcs-commit-message"]`, (e) => e.value).catch(() => null);
const buttonDisabled = (id) => page.$eval(`${PANEL} [data-testid="${id}"]`, (e) => e.disabled).catch(() => null);

try {
  // M3-1 the quick action opens the panel tab
  await H.openPopup(page);
  const popup = await H.popupText(page);
  await page.click('[data-testid="vcs-branch-popup"] [data-action="commit"]');
  const ok1 = await page.waitForSelector(PANEL, { timeout: 15_000 }).then(() => true, () => false);
  const closed1 = await page.waitForSelector('[data-testid="vcs-branch-popup"]', { hidden: true, timeout: 5000 }).then(() => true, () => false);
  step("M3-1 Commit... quick action (Ctrl+K hint) opens the Commit panel", /Commit\.\.\. \| Ctrl\+K/.test(popup) && ok1 && closed1, popup.slice(0, 160));
  await H.shot(page, "m3-1-panel");
  const clean = await waitPanel(/working tree is clean/);
  step("M3-2 a clean tree says so", /working tree is clean/.test(clean), clean.slice(0, 120));

  // M3-3 the list: tracked edit, staged edit, untracked file, partial
  sh(`cd ${REPO} && echo edited >> a.txt && echo staged >> b.txt && git add b.txt && echo more >> b.txt && echo new > ${NEW}`);
  const listed = await waitPanel(new RegExp(NEW));
  const okA = await waitCheckbox("Stage a.txt", "false");
  const okB = await waitCheckbox("Unstage b.txt", "mixed");
  const okN = await waitCheckbox(`Stage ${NEW}`, "false");
  step("M3-3 files are listed in groups with the checkbox as the staged state (partial = mixed)", /Changes \| \(2\)/.test(listed) && /Unversioned files \| \(1\)/.test(listed) && okA && okB && okN, `${okA} ${okB} ${okN} ${listed.slice(0, 200)}`);
  await H.shot(page, "m3-3-list");

  // M3-4 ticking stages, unticking unstages
  await page.click(`${PANEL} [aria-label="Stage a.txt"]`);
  const staged4 = await waitCheckbox("Unstage a.txt", "true");
  const st4 = status("a.txt");
  await page.click(`${PANEL} [aria-label="Unstage a.txt"]`);
  const unstaged4 = await waitCheckbox("Stage a.txt", "false");
  step("M3-4 the checkbox runs git add / git reset", staged4 && st4 === "M." && unstaged4 && status("a.txt") === ".M", `after add=${st4} after reset=${status("a.txt")}`);

  // M3-5 diff preview with the side switch
  await page.click(`${PANEL} [data-path="b.txt"] button[aria-pressed]`);
  const ok5 = await page.waitForSelector(`${PANEL} [data-testid="vcs-patch"]`, { timeout: 10_000 }).then(() => true, () => false);
  const sides = await page.$$eval(`${PANEL} [role="group"][aria-label="Diff side"] button`, (els) => els.map((e) => `${e.textContent.trim()}:${e.getAttribute("aria-pressed")}`)).catch(() => []);
  await page.click(`${PANEL} [role="group"][aria-label="Diff side"] button:nth-child(2)`);
  await sleep(1200);
  const sides2 = await page.$$eval(`${PANEL} [role="group"][aria-label="Diff side"] button`, (els) => els.map((e) => `${e.textContent.trim()}:${e.getAttribute("aria-pressed")}`)).catch(() => []);
  step("M3-5 selecting a file renders its patch; a partial file offers Staged / Unstaged", ok5 && sides.join(",") === "Staged:true,Unstaged:false" && sides2.join(",") === "Staged:false,Unstaged:true", `${sides} -> ${sides2}`);
  await H.shot(page, "m3-5-diff");

  // M3-6 commit: message on stdin, job, message cleared
  const before6 = head();
  await typeMessage(`${MSG}\n\nBody line`);
  const disabled6 = await buttonDisabled("vcs-commit-button");
  await page.click(`${PANEL} [data-testid="vcs-commit-button"]`);
  const toast6 = await waitPanel(/Committed [0-9a-f]+: Panel commit/);
  await sleep(1500);
  const body6 = sh(`git -C ${REPO} log -1 --format=%B`);
  step("M3-6 Commit runs as a job, commits the index with the message on stdin and clears the box", disabled6 === false && /Committed/.test(toast6) && head() !== before6 && body6 === `${MSG}\n\nBody line` && (await messageValue()) === "" && status("b.txt") === ".M", `toast="${toast6}" body="${body6.replace(/\n/g, "\\n")}"`);

  // M3-7 nothing staged disables Commit
  const hint7 = await waitPanel(/Nothing is staged/);
  step("M3-7 with nothing staged the Commit button is disabled and says why", /Nothing is staged/.test(hint7) && (await buttonDisabled("vcs-commit-button")) === true);

  // M3-8 amend: prefilled, exact command, parent unchanged
  const parent8 = sh(`git -C ${REPO} rev-parse HEAD~1`);
  await page.click(`${PANEL} [aria-label="Amend"]`);
  await sleep(400);
  const prefilled = await messageValue();
  await typeMessage(AMENDED);
  await page.click(`${PANEL} [data-testid="vcs-commit-button"]`);
  const cmd8 = await H.dialogCmd(page);
  await H.dialogButton(page, "Amend");
  const toast8 = await waitPanel(/Amended [0-9a-f]+: Amended/);
  await sleep(1000);
  step("M3-8 Amend prefills HEAD's message, previews git commit -F - --amend and keeps the parent", prefilled === `${MSG}\n\nBody line` && cmd8 === "git commit -F - --amend" && /Amended/.test(toast8) && subject() === AMENDED && sh(`git -C ${REPO} rev-parse HEAD~1`) === parent8, `prefilled="${(prefilled ?? "").slice(0, 40)}" cmd="${cmd8}"`);

  // M3-9 discard an untracked file: clean -f, destructive, file gone
  await page.hover(`${PANEL} [data-path="${NEW}"]`);
  await page.click(`${PANEL} [aria-label="Discard changes in ${NEW}"]`);
  const cmd9 = await H.dialogCmd(page);
  const dlg9 = await H.dialogText(page);
  await H.dialogButton(page, "Cancel");
  await sleep(500);
  const stillThere = existsSync(`${REPO}/${NEW}`);
  await page.hover(`${PANEL} [data-path="${NEW}"]`);
  await page.click(`${PANEL} [aria-label="Discard changes in ${NEW}"]`);
  await H.dialogCmd(page);
  await H.dialogButton(page, "Discard");
  await waitPanel(/Discarded changes/);
  await sleep(800);
  step("M3-9 Discard on an untracked file previews git clean -f, Cancel keeps it, Discard deletes it", cmd9 === `git --literal-pathspecs clean -f -- ${NEW}` && /delete 1 file/.test(dlg9) && stillThere && !existsSync(`${REPO}/${NEW}`), `cmd="${cmd9}"`);

  // M3-10 discard a tracked edit: restore --source=HEAD
  await page.hover(`${PANEL} [data-path="b.txt"]`);
  await page.click(`${PANEL} [aria-label="Discard changes in b.txt"]`);
  const cmd10 = await H.dialogCmd(page);
  await H.dialogButton(page, "Discard");
  await waitPanel(/Discarded changes in 1 file: reverted/);
  await sleep(800);
  step("M3-10 Discard on a tracked edit previews restore --source=HEAD and reverts the file", cmd10 === "git --literal-pathspecs restore --staged --worktree --source=HEAD -- b.txt" && sh(`git -C ${REPO} status --porcelain -- b.txt`) === "" && sh(`git -C ${REPO} show HEAD:b.txt`) === readFileSync(`${REPO}/b.txt`, "utf8").trim(), `cmd="${cmd10}"`);
  // a.txt still carries the edit from M3-3; discard it too and the tree is clean.
  await waitPanel(/Changes \| \(1\)/);
  await page.hover(`${PANEL} [data-path="a.txt"]`);
  await page.click(`${PANEL} [aria-label="Discard changes in a.txt"]`);
  await H.dialogCmd(page);
  await H.dialogButton(page, "Discard");
  await waitPanel(/Discarded changes in 1 file: reverted/);
  const clean10 = await waitPanel(/working tree is clean/);
  step("M3-10b discarding the other edit leaves the list empty", /working tree is clean/.test(clean10), clean10.slice(0, 120));

  // M3-11 hooks: a slow hook streams output; a failing hook is reported; Run Git hooks off skips it
  mkdirSync(HOOKS, { recursive: true });
  writeFileSync(`${HOOKS}/pre-commit`, "#!/bin/sh\necho 'hook working...' >&2\nsleep 3\necho 'hook says no' >&2\nexit 1\n");
  chmodSync(`${HOOKS}/pre-commit`, 0o755);
  sh(`git -C ${REPO} config core.hooksPath ${HOOKS}`);
  sh(`cd ${REPO} && echo hooked >> a.txt && git add a.txt`);
  await waitCheckbox("Unstage a.txt", "true");
  await typeMessage(`Hooked ${TS}`);
  const before11 = head();
  await sleep(500);
  const disabled11 = await buttonDisabled("vcs-commit-button");
  await H.shot(page, "m3-11-before-click");
  await page.click(`${PANEL} [data-testid="vcs-commit-button"]`);
  const busy11 = await waitPanel(/hook working/, 6000);
  await H.shot(page, "m3-11-after-click");
  const err11 = await waitPanel(/Commit failed: hook says no/, 15_000);
  step("M3-11 a pre-commit hook runs in the background job, streams its output and its refusal is the error", /Committing/.test(busy11) && /hook working/.test(busy11) && /hook says no/.test(err11) && head() === before11, `disabled=${disabled11} busy="${busy11.slice(0, 160)}" err="${err11.slice(-200)}"`);
  await page.click(`${PANEL} [aria-label="Run Git hooks"]`);
  await page.click(`${PANEL} [data-testid="vcs-commit-button"]`);
  const toast11 = await waitPanel(/Committed [0-9a-f]+: Hooked/);
  await sleep(800);
  step("M3-11b with Run Git hooks off the commit passes with --no-verify", /Committed/.test(toast11) && head() !== before11, toast11);
  sh(`git -C ${REPO} config --unset core.hooksPath`);
  await page.click(`${PANEL} [aria-label="Run Git hooks"]`);

  // M3-12 live refresh after a terminal git add, then Commit and Push
  sh(`cd ${REPO} && echo pushme >> b.txt`);
  const seen12 = await waitCheckbox("Stage b.txt", "false");
  sh(`git -C ${REPO} add b.txt`);
  const staged12 = await waitCheckbox("Unstage b.txt", "true");
  step("M3-12 an edit and a git add from a terminal reach the panel without a click", seen12 && staged12);
  await typeMessage(PUSHED);
  await page.click(`${PANEL} [data-testid="vcs-commit-push-button"]`);
  await waitPanel(/Committed [0-9a-f]+: Pushed/);
  const cmd12 = await H.dialogCmd(page);
  await H.dialogButton(page, "Push");
  const toast12 = await waitPanel(/Pushed main to origin\/main/);
  await sleep(800);
  const noToasts = (await H.toastText(page)) === "";
  step("M3-13 Commit and Push commits, then previews the tracked push and pushes HEAD; the panel raises no toast", cmd12 === "git push --no-progress --end-of-options origin HEAD:refs/heads/main" && /Pushed main/.test(toast12) && sh(`git --git-dir=${BARE} rev-parse main`) === head() && noToasts, `cmd="${cmd12}" status="${toast12.slice(-120)}" noToasts=${noToasts}`);

  // M3-14 palette: seven rows, Commit... opens the panel directly
  await page.keyboard.press("Escape");
  await sleep(300);
  await H.palette(page, "VCS Group");
  const rows = await H.paletteRows(page);
  await H.clickPaletteRow(page, "VCS Group: Commit");
  await sleep(1500);
  const popupOpen = !!(await page.$('[data-testid="vcs-branch-popup"]'));
  const panelOpen = !!(await page.$(PANEL));
  step("M3-14 seven palette rows; Commit... opens the panel without the popup", rows.length === 7 && rows.some((r) => /Commit\.\.\./.test(r)) && panelOpen && !popupOpen, JSON.stringify(rows));
  await H.shot(page, "m3-14-end");
} finally {
  await a.browser.close();
  sh(`git -C ${REPO} config --unset core.hooksPath`);
  sh(`rm -rf ${HOOKS}`);
}

process.exit(summary() ? 0 : 1);
