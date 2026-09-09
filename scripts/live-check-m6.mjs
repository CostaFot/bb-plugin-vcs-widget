// Headless click-through of the commit panel's three later additions against
// a running bb: the file row's context menu (Copy Path, Discard), the group
// header's Discard All Changes, and the "LGTM - Commit" button that hands the
// commit to the agent in this thread.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m6.mjs /tmp/vcs-scratch
//
// The last scenario sends a real message to VCS_E2E_THREAD, so it runs after
// the tree is clean: the agent it wakes has nothing to commit.
//
// See docs/VERIFY.md. Needs system Chromium and puppeteer-core in node_modules.
import { browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m6.mjs <repo path>");
  process.exit(2);
}
const BASE = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const JUNK = `junk-${TS}.txt`;
const PANEL = '[data-testid="vcs-commit-panel"]';
const MENU = '[data-testid="vcs-file-menu"]';

sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} clean -fdq`);

const a = await H.launch("m6");
const page = a.page;
await a.browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write"]).catch(() => {});

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
const notice = () => page.$eval(`${PANEL} [data-testid="vcs-commit-notice"]`, (e) => e.innerText.replace(/\n+/g, " ")).catch(() => "");
const waitNotice = async (re, ms = 15_000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await notice();
    if (re.test(last)) return last;
    await sleep(300);
  }
  return `TIMEOUT last="${last}"`;
};
async function openFileMenu(path) {
  await page.click(`${PANEL} [data-path="${path}"]`, { button: "right" });
  await page.waitForSelector(MENU, { timeout: 10_000 });
  await sleep(400);
}
const menuLabels = () => page.$$eval(`${MENU} [role="menuitem"]`, (els) => els.map((e) => e.innerText.trim()));
async function clickFileMenu(id) {
  await page.click(`${MENU} [data-menu-id="${id}"]`);
  await sleep(800);
}

try {
  // The panel, and a working tree with two tracked edits and one new file.
  await H.openPopup(page);
  await page.click('[data-testid="vcs-branch-popup"] [data-action="commit"]');
  await page.waitForSelector(PANEL, { timeout: 15_000 });
  sh(`cd ${REPO} && echo m6-a >> a.txt && echo m6-b >> b.txt && echo junk > ${JUNK}`);
  const listed = await waitPanel(new RegExp(JUNK));
  step("M6-0 the panel lists two changes and one unversioned file", /Changes \| \(2\)/.test(listed) && /Unversioned files \| \(1\)/.test(listed), listed.slice(0, 200));

  // M6-1 the row's context menu
  await openFileMenu("a.txt");
  const labels = await menuLabels();
  step("M6-1 right-clicking a file row opens Copy Path and Discard", labels.join(",") === "Copy Path,Discard", labels.join(","));
  await H.shot(page, "m6-1-file-menu");

  // M6-2 Copy Path. Headless Chromium denies clipboard-write whatever
  // overridePermissions says (a plain button in the same page fails the same
  // way), so this asserts that the item runs and that the panel reports what
  // happened; the copy itself is a hand check (docs/VERIFY.md).
  await clickFileMenu("copy-path");
  const copiedNotice = await waitNotice(/Copied a\.txt|Could not copy/);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "unreadable");
  const permission = await page.evaluate(() => navigator.permissions.query({ name: "clipboard-write" }).then((r) => r.state, (e) => e.name));
  const copied = /Copied a\.txt/.test(copiedNotice) && (clipboard === "a.txt" || clipboard === "unreadable");
  step(
    "M6-2 Copy Path runs and reports (a headless browser denies the write)",
    copied || (permission === "denied" && /Could not copy the path\./.test(copiedNotice)),
    `notice="${copiedNotice}" clipboard="${clipboard}" clipboard-write=${permission}`,
  );

  // M6-3 Discard from the menu, on the untracked file
  await openFileMenu(JUNK);
  await clickFileMenu("discard");
  const cmd3 = await H.dialogCmd(page);
  const text3 = await H.dialogText(page);
  await H.dialogButton(page, "Discard");
  await sleep(2500);
  const gone = sh(`test -e ${REPO}/${JUNK} && echo present || echo gone`);
  step("M6-3 Discard from the menu deletes the untracked file after showing the command", cmd3 === `git --literal-pathspecs clean -f -- ${JUNK}` && /delete 1 file/.test(text3) && gone === "gone", `cmd="${cmd3}" ${gone}`);

  // M6-4 the group header discards everything in the group at once
  const headers = await page.$$eval(`${PANEL} button[aria-label^="Discard all changes in"]`, (els) => els.map((e) => e.getAttribute("aria-label")));
  await page.click(`${PANEL} [aria-label="Discard all changes in Changes"]`);
  const cmd4 = await H.dialogCmd(page);
  const text4 = await H.dialogText(page);
  await H.dialogButton(page, "Discard");
  await sleep(2500);
  const dirty = sh(`git -C ${REPO} status --porcelain`);
  step(
    "M6-4 the Changes header discards the whole group in one dialog",
    headers.join(",") === "Discard all changes in Changes" &&
      cmd4 === "git --literal-pathspecs restore --staged --worktree --source=HEAD -- a.txt b.txt" &&
      /Discard changes in 2 files/.test(text4) &&
      dirty === "",
    `headers=[${headers}] cmd="${cmd4}" status="${dirty}"`,
  );
  await H.shot(page, "m6-4-group-discard");

  // M6-5 the agent takes the commit. The tree is clean by now, so the turn
  // this starts has nothing to do.
  // The thread's own event log, not `bb thread history`: the prompt history
  // collapses identical prompts, so a second run would look like no message.
  const sentCount = () => sh(`bb thread log ${H.THREAD}`).split("LGTM - Commit").length - 1;
  const before = sentCount();
  const disabled = await page.$eval(`${PANEL} [data-testid="vcs-agent-commit-button"]`, (e) => e.disabled).catch(() => null);
  await page.click(`${PANEL} [data-testid="vcs-agent-commit-button"]`);
  const sentNotice = await waitNotice(/sent to the agent|queued/i);
  let landed = false;
  for (let i = 0; i < 10 && !landed; i += 1) {
    landed = sentCount() > before;
    if (!landed) await sleep(1500);
  }
  step("M6-5 LGTM - Commit is always enabled and reaches the thread as a user message", disabled === false && /sent to the agent|queued/i.test(sentNotice) && landed, `notice="${sentNotice}" landed=${landed}`);
  await H.shot(page, "m6-5-lgtm");
} finally {
  await a.browser.close();
}

process.exit(summary() ? 0 : 1);
