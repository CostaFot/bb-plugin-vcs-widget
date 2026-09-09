// Headless click-through of the milestone 4 git log against a running bb:
// the Show Git Log quick action and palette row, the list with its ref
// badges, the branch and message filters, the details drawer and per-file
// diff, the per-commit context menu, cherry-pick, revert, reset, New Branch
// from a commit, Compare with the current branch, and live refresh after a
// terminal commit.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m4.mjs /tmp/vcs-scratch
//
// See docs/VERIFY.md. Needs system Chromium and puppeteer-core in node_modules.
import { GIT_ID, browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m4.mjs <repo path>");
  process.exit(2);
}
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const SIDE = `logside-${TS}`;
const PICKED = `Pick me ${TS}`;
const LATER = `Later ${TS}`;
const FROM_LOG = `from-log-${TS}`;
const PANEL = '[data-testid="vcs-log-panel"]';

const head = () => sh(`git -C ${REPO} rev-parse HEAD`);
const subject = () => sh(`git -C ${REPO} log -1 --format=%s`);
const revParse = (rev) => sh(`git -C ${REPO} rev-parse ${rev}`);

// A known history: main at origin, one commit on a side branch to pick.
sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} clean -fdq`);
sh(`git -C ${REPO} branch -D ${SIDE}`);
sh(`git -C ${REPO} switch -q -c ${SIDE}`);
sh(`cd ${REPO} && echo picked > pick-${TS}.txt && git ${GIT_ID} add pick-${TS}.txt && git ${GIT_ID} commit -q -m "${PICKED}"`);
const pickSha = head();
sh(`git -C ${REPO} switch -q main`);
const mainSha = head();

const a = await H.launch("m4");
const page = a.page;

const panelText = async () => (await page.$eval(PANEL, (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
const waitPanel = async (re, ms = 20_000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await panelText();
    if (re.test(last)) return last;
    await sleep(300);
  }
  return `TIMEOUT last="${last.slice(0, 400)}"`;
};
const rowSubjects = () =>
  page.$$eval(`${PANEL} [data-sha]`, (rows) => rows.map((row) => row.innerText.replace(/\n+/g, " ").trim())).catch(() => []);
const waitRow = async (sha, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.$(`${PANEL} [data-sha="${sha}"]`)) return true;
    await sleep(300);
  }
  return false;
};
async function openCommitMenu(sha) {
  await page.click(`${PANEL} [data-sha="${sha}"]`, { button: "right" });
  await page.waitForSelector('[data-testid="vcs-commit-menu"]', { timeout: 10_000 });
  await sleep(400);
}
const commitMenuLabels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="vcs-commit-menu"] [role="menuitem"]')].map((e) => e.innerText.replace(/\n+/g, " ").trim()),
  );
async function clickCommitMenu(id) {
  await page.click(`[data-testid="vcs-commit-menu"] [data-menu-id="${id}"]`);
  await sleep(600);
}
const selectFilter = async (value) => {
  await page.select(`${PANEL} [data-testid="vcs-log-filter"]`, value);
  await sleep(1500);
};

try {
  // M4-1 the quick action opens the panel tab and closes the popup
  await H.openPopup(page);
  const popup = await H.popupText(page);
  await page.click('[data-testid="vcs-branch-popup"] [data-action="log"]');
  const opened = await page.waitForSelector(PANEL, { timeout: 15_000 }).then(() => true, () => false);
  const closed = await page.waitForSelector('[data-testid="vcs-branch-popup"]', { hidden: true, timeout: 5000 }).then(() => true, () => false);
  step("M4-1 Show Git Log quick action opens the log panel", /Show Git Log/.test(popup) && opened && closed, popup.slice(0, 160));
  await H.shot(page, "m4-1-panel");

  // M4-2 the list, newest first, with the refs the tip carries
  await waitRow(mainSha);
  const rows2 = await rowSubjects();
  const badges = await page
    .$$eval(`${PANEL} [data-sha="${mainSha}"] [data-ref-kind]`, (els) => els.map((e) => `${e.getAttribute("data-ref-kind")}:${e.textContent.trim()}`))
    .catch(() => []);
  step(
    "M4-2 the log lists commits newest first with the refs on the tip as badges",
    rows2.length > 0 && badges.includes("head:HEAD") && badges.includes("local:main") && badges.some((b) => b.startsWith("remote:origin/main")),
    `${rows2.length} rows, badges=${JSON.stringify(badges)}`,
  );

  // M4-3 the side branch is only in the log when the filter walks all branches
  const allBranches = await waitRow(pickSha);
  await selectFilter("head");
  const onlyHead = !(await page.$(`${PANEL} [data-sha="${pickSha}"]`));
  await selectFilter("all");
  step("M4-3 the branch filter changes which refs the log walks", allBranches && onlyHead && (await waitRow(pickSha)), `all=${allBranches} head-only=${onlyHead}`);

  // M4-4 the message filter is a literal substring search
  await page.click(`${PANEL} [data-testid="vcs-log-search"]`);
  await page.keyboard.type(PICKED);
  await sleep(2000);
  const filtered = await rowSubjects();
  await page.click(`${PANEL} [data-testid="vcs-log-search"]`);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(`${PICKED}.`);
  await sleep(2000);
  const literal = await panelText();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(1500);
  step(
    "M4-4 the message filter matches literally, so a regex character finds nothing",
    filtered.length === 1 && filtered[0].includes(PICKED) && /No commit matches this filter/.test(literal),
    `filtered=${filtered.length} literal="${literal.slice(0, 120)}"`,
  );

  // M4-5 the details drawer and one file's diff
  await waitRow(pickSha);
  await page.click(`${PANEL} [data-sha="${pickSha}"] button[aria-pressed]`);
  await page.waitForSelector(`${PANEL} [data-testid="vcs-log-details"]`, { timeout: 15_000 });
  const shown = await page.$eval(`${PANEL} [data-testid="vcs-log-sha"]`, (e) => e.textContent.trim()).catch(() => "");
  const details = await panelText();
  await page.click(`${PANEL} [data-path="pick-${TS}.txt"]`);
  const diffOk = await page.waitForSelector(`${PANEL} [data-testid="vcs-patch"]`, { timeout: 15_000 }).then(() => true, () => false);
  await page.click(`${PANEL} [data-testid="vcs-log-back"]`);
  const back = await page.waitForSelector(`${PANEL} [data-testid="vcs-log-details"]`, { timeout: 10_000 }).then(() => true, () => false);
  step(
    "M4-5 selecting a commit shows its sha, message and files; a file renders its diff and Back returns",
    shown === pickSha && details.includes(PICKED) && details.includes(`pick-${TS}.txt`) && diffOk && back,
    `sha=${shown.slice(0, 12)} diff=${diffOk} back=${back}`,
  );
  await H.shot(page, "m4-5-details");

  // M4-6 the context menu, and Cherry-Pick with its exact command
  await openCommitMenu(pickSha);
  const labels = await commitMenuLabels();
  await clickCommitMenu("cherry-pick");
  const cmd6 = await H.dialogCmd(page);
  await H.dialogButton(page, "Cherry-pick");
  const status6 = await waitPanel(/Cherry-picked/);
  await sleep(1000);
  step(
    "M4-6 the commit menu lists the IntelliJ rows and Cherry-Pick previews the exact command",
    labels.length === 7 &&
      labels[0] === "Checkout Revision" &&
      labels.some((l) => /New Branch from/.test(l)) &&
      labels.includes("Copy Revision Number") &&
      cmd6 === `git cherry-pick --end-of-options ${pickSha}` &&
      subject() === PICKED &&
      head() !== mainSha,
    `labels=${JSON.stringify(labels)} cmd="${cmd6}" status="${status6.slice(-120)}"`,
  );
  const pickedOnMain = head();

  // M4-7 Revert the commit just picked
  await waitRow(pickedOnMain);
  await openCommitMenu(pickedOnMain);
  await clickCommitMenu("revert");
  const cmd7 = await H.dialogCmd(page);
  await H.dialogButton(page, "Revert");
  const status7 = await waitPanel(/Reverted/);
  await sleep(1000);
  step(
    "M4-7 Revert Commit previews git revert --no-edit and commits the inverse",
    cmd7 === `git revert --no-edit --end-of-options ${pickedOnMain}` && /^Revert /.test(subject()) && sh(`ls ${REPO}/pick-${TS}.txt`).startsWith("ERR"),
    `cmd="${cmd7}" subject="${subject()}" status="${status7.slice(-120)}"`,
  );

  // M4-8 Reset --hard back to the commit main started at
  await waitRow(mainSha);
  await openCommitMenu(mainSha);
  await page.hover('[data-testid="vcs-commit-menu"] [data-menu-id="reset"]');
  await page.waitForSelector('[data-reset-mode="hard"]', { timeout: 10_000 });
  await page.click('[data-reset-mode="hard"]');
  const cmd8 = await H.dialogCmd(page);
  const dlg8 = await H.dialogText(page);
  await H.dialogButton(page, "Reset --hard");
  const status8 = await waitPanel(/Reset main to/);
  await sleep(1000);
  step(
    "M4-8 Reset Current Branch to Here (Hard) is a destructive confirm and moves the branch",
    cmd8 === `git reset --hard --end-of-options ${mainSha} --` && /throw away/.test(dlg8) && head() === mainSha,
    `cmd="${cmd8}" head=${head().slice(0, 8)} status="${status8.slice(-120)}"`,
  );

  // M4-9 New Branch from a commit
  await openCommitMenu(pickSha);
  await clickCommitMenu("new-branch-from");
  await page.waitForSelector('[aria-label="New branch name"]', { timeout: 10_000 });
  await page.type('[aria-label="New branch name"]', FROM_LOG);
  await page.evaluate(() => {
    const create = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Create");
    create?.click();
  });
  await sleep(2500);
  const created = revParse(FROM_LOG);
  step("M4-9 New Branch from a commit creates it at that sha and checks it out", created === pickSha && sh(`git -C ${REPO} symbolic-ref --short HEAD`) === FROM_LOG, `${FROM_LOG}=${created.slice(0, 8)} want ${pickSha.slice(0, 8)}`);
  sh(`git -C ${REPO} switch -q main`);

  // M4-10 Compare with the current branch opens the compare tab on the revision
  await sleep(2000);
  await waitRow(pickSha);
  await openCommitMenu(pickSha);
  await clickCommitMenu("compare");
  const compared = await page.waitForSelector('[data-testid="vcs-compare-counts"]', { timeout: 20_000 }).then(() => true, () => false);
  const compareText = await page.evaluate(() => document.body.innerText.replace(/\n+/g, " | "));
  step("M4-10 Compare with the current branch opens the compare tab against the revision", compared && compareText.includes(PICKED), `compared=${compared}`);
  await H.shot(page, "m4-10-compare");

  // M4-11 a commit made in a terminal reaches the open log
  await H.palette(page, "VCS Group: Show Git Log");
  await H.clickPaletteRow(page, "VCS Group: Show Git Log");
  await page.waitForSelector(PANEL, { timeout: 15_000 });
  const popupOpen = !!(await page.$('[data-testid="vcs-branch-popup"]'));
  const rows11 = await H.paletteRows(page).catch(() => []);
  sh(`cd ${REPO} && echo later >> a.txt && git ${GIT_ID} commit -q -am "${LATER}"`);
  const liveSha = head();
  const live = await waitRow(liveSha, 25_000);
  step("M4-11 the palette row opens the log without the popup, and a terminal commit shows up without a click", !popupOpen && live, `popup=${popupOpen} live=${live} rows=${rows11.length}`);
  await H.shot(page, "m4-11-live");

  // M4-12 eight palette rows
  await page.keyboard.press("Escape");
  await sleep(300);
  await H.palette(page, "VCS Group");
  const rows12 = await H.paletteRows(page);
  await page.keyboard.press("Escape");
  step("M4-12 eight palette rows, including Show Git Log", rows12.length === 8 && rows12.some((r) => /Show Git Log/.test(r)), JSON.stringify(rows12));
  await H.shot(page, "m4-12-end");
} finally {
  await a.browser.close();
  sh(`git -C ${REPO} switch -q main`);
  sh(`git -C ${REPO} reset -q --hard origin/main`);
  sh(`git -C ${REPO} branch -D ${SIDE}`);
  sh(`git -C ${REPO} branch -D ${FROM_LOG}`);
  sh(`git -C ${REPO} clean -fdq`);
}

process.exit(summary() ? 0 : 1);
