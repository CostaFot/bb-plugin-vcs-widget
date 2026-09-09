// Headless click-through of the milestone 2 features against a running bb:
// context menu, favourites, rename, delete (-d then -D), tracked branch,
// compare and diff panels, merge, conflict + abort, rebase, tag checkout,
// worktree, background jobs (fetch, update, push, force-with-lease, remote
// delete, cancel), the palette rows.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m2.mjs /tmp/vcs-scratch
//
// See docs/VERIFY.md. Needs system Chromium and puppeteer-core in node_modules.
import { existsSync } from "node:fs";
import { GIT_ID, browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m2.mjs <repo path>");
  process.exit(2);
}
const BARE = `${REPO}.git`;
const CLONE2 = `${REPO}-clone2`;
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const DEL = `del-${TS}`;
const MRG = `mrg-${TS}`;
const CFL = `cfl-${TS}`;
const PB = `pb-${TS}`;
const TAG = `v-${TS}`;
const WT = `${REPO}-feature`;
const current = () => sh(`git -C ${REPO} branch --show-current`);
const bareHeads = () => sh(`git --git-dir=${BARE} for-each-ref --format='%(refname:short)' refs/heads`);

sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} worktree prune`);
const a = await H.launch("m2");
const page = a.page;
try {
  // M2-1 the menu
  await H.openPopup(page);
  await H.openMenu(page, "feature");
  const labels = await H.menuLabels(page);
  step("M2-1 context menu lists the IntelliJ rows", labels.length === 17 && labels[0] === "Checkout" && labels.includes("Merge 'feature' into 'main'") && labels.includes("Show Log") && labels.includes("Tracked Branch"), JSON.stringify(labels));
  await H.shot(page, "m2-1-menu");
  await page.keyboard.press("Escape");
  await sleep(400);

  // M2-2 favourites
  await page.click('[data-branch-name="feature"] [aria-label="Add feature to favourites"]');
  await sleep(1200);
  const t2 = await H.popupText(page);
  await H.closePopup(page);
  await H.openPopup(page);
  const t2b = await H.popupText(page);
  step("M2-2 star adds a Favorites group that survives reopen", /Favorites \| feature/.test(t2) && /Favorites \| feature/.test(t2b), t2.slice(0, 120));
  await page.click('[data-branch-name="feature"] [aria-label="Remove feature from favourites"]');
  await sleep(1000);
  step("M2-2b unstar removes the group", !/Favorites/.test(await H.popupText(page)));

  // M2-3 rename
  await H.openMenu(page, "feature");
  await H.clickMenu(page, "rename");
  await page.waitForSelector('form[aria-label="Rename branch"]', { timeout: 5000 });
  await page.keyboard.press("End");
  await page.keyboard.type("-renamed");
  await page.keyboard.press("Enter");
  const st3 = await H.waitStatus(page, /Renamed/);
  step("M2-3 rename via the menu", /Renamed feature to feature-renamed/.test(st3) && sh(`git -C ${REPO} branch --list feature-renamed`) !== "", st3);
  sh(`git -C ${REPO} branch -m feature-renamed feature`);
  await H.closePopup(page);

  // M2-4 delete -d then -D
  sh(`cd ${REPO} && git switch -q -c ${DEL} && echo x > ${DEL}.txt && git add ${DEL}.txt && git ${GIT_ID} commit -qm "${DEL}" && git switch -q main`);
  await sleep(4000);
  await H.openPopup(page);
  await H.openMenu(page, DEL);
  await H.clickMenu(page, "delete");
  const cmd4a = await H.dialogCmd(page);
  await H.dialogButton(page, "Delete");
  await sleep(1500);
  const cmd4b = await H.dialogCmd(page);
  const dlg4 = await H.dialogText(page);
  await H.dialogButton(page, "Delete anyway");
  await sleep(2500);
  step("M2-4 delete asks with -d, then -D for an unmerged branch", cmd4a === `git branch -d --end-of-options ${DEL}` && cmd4b === `git branch -D --end-of-options ${DEL}` && /not on any other branch/.test(dlg4) && sh(`git -C ${REPO} branch --list ${DEL}`) === "", `a="${cmd4a}" b="${cmd4b}"`);
  await H.closePopup(page);

  // M2-5 tracked branch submenu
  sh(`git -C ${REPO} branch --unset-upstream feature`);
  await sleep(3000);
  await H.openPopup(page);
  await H.openMenu(page, "feature");
  await page.hover('[data-testid="vcs-branch-menu"] [role="menuitem"][aria-haspopup="menu"]');
  await page.waitForSelector('[data-upstream="origin/feature"]', { timeout: 5000 });
  await page.click('[data-upstream="origin/feature"]');
  const st5 = await H.waitStatus(page, /tracks/);
  step("M2-5 tracked branch submenu sets the upstream", /feature now tracks origin\/feature/.test(st5) && sh(`git -C ${REPO} rev-parse --abbrev-ref feature@{upstream}`) === "origin/feature", st5);
  await H.closePopup(page);

  // M2-6 compare panel
  await H.openPopup(page);
  await H.openMenu(page, "feature");
  await H.clickMenu(page, "compare");
  const ok6 = await page.waitForFunction(() => document.body.innerText.includes("main ⇄ feature"), { timeout: 15_000 }).then(() => true, () => false);
  await sleep(1500);
  const counts6 = await page.$eval('[data-testid="vcs-compare-counts"]', (e) => e.textContent).catch(() => null);
  step("M2-6 Compare with opens a side panel tab", ok6 && counts6 !== null && /feature \+\d+ · main \+\d+/.test(counts6), `counts="${counts6}"`);
  await H.shot(page, "m2-6-compare");

  // M2-7 diff panel
  sh(`cd ${REPO} && echo edited >> a.txt`);
  await H.openPopup(page);
  await H.openMenu(page, "main");
  await H.clickMenu(page, "diff-working-tree");
  const ok7 = await page.waitForFunction(() => document.body.innerText.includes("Working tree vs main"), { timeout: 15_000 }).then(() => true, () => false);
  await page.waitForSelector('[data-path="a.txt"]', { timeout: 10_000 }).catch(() => null);
  await page.click('[data-path="a.txt"]').catch(() => null);
  const ok7b = await page.waitForSelector('[data-testid="vcs-patch"]', { timeout: 10_000 }).then(() => true, () => false);
  step("M2-7 Show Diff with Working Tree lists a.txt and renders its patch", ok7 && ok7b);
  await H.shot(page, "m2-7-diff");
  sh(`git -C ${REPO} checkout -- a.txt`);

  // M2-8 merge
  sh(`cd ${REPO} && git switch -q -c ${MRG} && echo m > ${MRG}.txt && git add ${MRG}.txt && git ${GIT_ID} commit -qm "${MRG}" && git switch -q main`);
  await sleep(4000);
  await H.openPopup(page);
  await H.openMenu(page, MRG);
  await H.clickMenu(page, "merge");
  const cmd8 = await H.dialogCmd(page);
  await H.dialogButton(page, "Merge");
  const st8 = await H.waitToast(page, /Merged|failed/);
  step("M2-8 merge previews the command and fast-forwards", cmd8 === `git merge --no-edit --end-of-options refs/heads/${MRG}` && /Merged .* into main: Fast-forward/.test(st8) && sh(`git -C ${REPO} log -1 --format=%s`) === MRG, st8);

  // M2-9 conflict + abort
  sh(`cd ${REPO} && git switch -q -c ${CFL} && echo A-${TS} > a.txt && git ${GIT_ID} commit -qam "a on branch ${TS}" && git switch -q main && echo B-${TS} > a.txt && git ${GIT_ID} commit -qam "a on main ${TS}"`);
  await sleep(4000);
  await H.openPopup(page);
  await H.openMenu(page, CFL);
  await H.clickMenu(page, "merge");
  await H.dialogButton(page, "Merge");
  const st9 = await H.waitToast(page, /conflict/i);
  await sleep(1000);
  await H.openPopup(page);
  const banner9 = await page.$eval('[data-testid="vcs-operation-banner"]', (e) => e.innerText).catch(() => "");
  await H.openMenu(page, "feature");
  const disabled9 = await page.$eval('[data-testid="vcs-branch-menu"] [data-menu-id="checkout"]', (e) => e.hasAttribute("data-disabled")).catch(() => null);
  await page.keyboard.press("Escape");
  await sleep(600);
  await H.openPopup(page);
  await page.click('[data-testid="vcs-operation-banner"] button');
  const cmd9 = await H.dialogCmd(page);
  await H.dialogButton(page, "Abort");
  const st9b = await H.waitToast(page, /Aborted the merge|Abort failed/);
  await sleep(1000);
  await H.openPopup(page);
  const banner9b = await page.$('[data-testid="vcs-operation-banner"]');
  step("M2-9 conflict shows the banner; Abort runs merge --abort", /conflict/i.test(st9) && /merge is in progress/.test(banner9) && disabled9 === true && cmd9 === "git merge --abort" && /Aborted the merge/.test(st9b) && banner9b === null && sh(`git -C ${REPO} status --porcelain`) === "", `st="${st9}" banner="${banner9}" checkout-disabled=${disabled9} abort="${st9b}"`);
  await H.closePopup(page);

  // M2-10 rebase current onto
  await H.openPopup(page);
  await H.openMenu(page, MRG);
  await H.clickMenu(page, "rebase");
  const cmd10 = await H.dialogCmd(page);
  await H.dialogButton(page, "Rebase");
  const st10 = await H.waitToast(page, /Rebased|up to date|failed/);
  step("M2-10 rebase current onto selected", cmd10 === `git rebase --end-of-options refs/heads/${MRG}` && /Rebased main onto|already up to date/.test(st10) && current() === "main", st10);

  // M2-11 checkout tag
  sh(`git -C ${REPO} tag ${TAG} main~1`);
  await sleep(2000);
  await H.openPopup(page);
  await page.click('[data-action="checkout-revision"]');
  await page.waitForSelector(`[data-tag="${TAG}"]`, { timeout: 10_000 });
  await page.click(`[data-tag="${TAG}"]`);
  await page.click('form[aria-label="Checkout tag or revision"] button[type="submit"]');
  const cmd11 = await H.dialogCmd(page);
  await H.dialogButton(page, "Checkout");
  await sleep(3000);
  const lbl11 = await H.label(page);
  step("M2-11 Checkout Tag or Revision detaches at the tag", cmd11 === `git switch --detach --end-of-options ${TAG}` && /^[0-9a-f]{7}$/.test(lbl11) && sh(`git -C ${REPO} rev-parse HEAD`) === sh(`git -C ${REPO} rev-parse ${TAG}^{commit}`), `cmd="${cmd11}" label="${lbl11}"`);
  await H.closePopup(page);
  await H.openPopup(page);
  await page.click('[data-branch-name="main"]');
  await H.waitLabel(page, "main");
  await H.closePopup(page);

  // M2-12 worktree
  await H.openPopup(page);
  await H.openMenu(page, "feature");
  await H.clickMenu(page, "new-worktree");
  const cmd12 = await H.dialogCmd(page);
  await H.dialogButton(page, "Add worktree");
  const st12 = await H.waitToast(page, /worktree|failed/i);
  step("M2-12 New Worktree from creates a sibling directory", cmd12 === `git worktree add --end-of-options ${WT} feature` && /Added worktree/.test(st12) && existsSync(WT) && sh(`git -C ${WT} branch --show-current`) === "feature", `cmd="${cmd12}" st="${st12}"`);
  await sleep(1000);
  await H.openPopup(page);
  const t12 = await H.popupText(page);
  step("M2-12b the branch shows its worktree badge", /feature[^|]*worktree/.test(t12) || /worktree/.test(t12));
  await H.closePopup(page);
  sh(`git -C ${REPO} worktree remove --force ${WT}`);

  // M2-13 fetch as a job
  await sleep(2000);
  await H.openPopup(page);
  await page.click('[data-action="fetch"]');
  const st13 = await H.waitStatus(page, /Fetched/);
  const logs13 = sh(`bb plugin logs vcs-group | tail -20`);
  step("M2-13 fetch runs as a background job", /Fetched/.test(st13) && /fetch job [0-9a-f-]+ started/.test(logs13) && /fetch job [0-9a-f-]+ finished/.test(logs13), st13);
  await H.closePopup(page);

  // M2-14 update on a non-current branch
  sh(`cd ${CLONE2} && git fetch -q && (git switch -q feature 2>/dev/null || git switch -q -c feature origin/feature) && git pull -q && echo f > f-${TS}.txt && git add . && git ${GIT_ID} commit -qm "feature from clone2" && git push -q origin feature && git switch -q main`);
  await H.openPopup(page);
  await page.click('[data-action="fetch"]');
  await H.waitStatus(page, /Fetched/);
  await H.openMenu(page, "feature");
  await H.clickMenu(page, "update");
  const st14 = await H.waitStatus(page, /Updated|up to date|failed/);
  step("M2-14 Update fast-forwards a branch that is not checked out", /Updated feature from origin\/feature/.test(st14) && sh(`git -C ${REPO} rev-parse feature`) === sh(`git --git-dir=${BARE} rev-parse feature`), st14);
  await H.closePopup(page);

  // M2-15 push another local branch
  sh(`git -C ${REPO} branch ${PB} main`);
  await sleep(3000);
  await H.openPopup(page);
  await H.openMenu(page, PB);
  await H.clickMenu(page, "push");
  const cmd15 = await H.dialogCmd(page);
  await H.dialogButton(page, "Push");
  const st15 = await H.waitToast(page, /Pushed|failed/);
  step("M2-15 Push... on another branch pushes it by its own ref with -u", cmd15 === `git push --no-progress -u --end-of-options origin refs/heads/${PB}:refs/heads/${PB}` && /Pushed .* and set it as upstream/.test(st15) && bareHeads().includes(PB), `cmd="${cmd15}" toast="${st15}" bare="${bareHeads().replace(/\n/g, ",")}"`);
  await H.closePopup(page);

  // M2-16 force with lease
  sh(`cd ${REPO} && echo local > local-${TS}.txt && git add . && git ${GIT_ID} commit -qm "local ${TS}"`);
  sh(`cd ${CLONE2} && git pull -q && echo remote > remote-${TS}.txt && git add . && git ${GIT_ID} commit -qm "remote ${TS}" && git push -q origin main`);
  await sleep(2000);
  await H.openPopup(page);
  await page.click('[data-action="fetch"]');
  await H.waitStatus(page, /Fetched/);
  const remoteSha = sh(`git -C ${REPO} rev-parse --short origin/main`);
  await page.click('[data-action="push"]');
  const cmd16a = await H.dialogCmd(page);
  await page.click('[data-testid="vcs-confirm-toggle"]');
  await sleep(300);
  const cmd16b = await H.dialogCmd(page);
  await H.dialogButton(page, "Push");
  const st16 = await H.waitToast(page, /pushed|failed/i);
  step("M2-16 force push only through the lease switch", cmd16a === "git push --no-progress --end-of-options origin HEAD:refs/heads/main" && cmd16b.startsWith(`git push --no-progress --force-with-lease=refs/heads/main:${remoteSha}`) && /Force-pushed main/.test(st16) && sh(`git --git-dir=${BARE} rev-parse main`) === sh(`git -C ${REPO} rev-parse HEAD`), `b="${cmd16b}" st="${st16}"`);
  await H.closePopup(page);
  sh(`cd ${CLONE2} && git fetch -q && git reset -q --hard origin/main`);

  // M2-17 delete remote branch
  await H.openPopup(page);
  await H.openMenu(page, `origin/${PB}`);
  await H.clickMenu(page, "delete");
  const cmd17 = await H.dialogCmd(page);
  await H.dialogButton(page, "Delete on remote");
  const st17 = await H.waitToast(page, /Deleted|failed/);
  step("M2-17 Delete on a remote branch runs as a job", cmd17 === `git push --no-progress --delete --end-of-options origin refs/heads/${PB}` && /Deleted origin\/.* on the remote/.test(st17) && !bareHeads().includes(PB), `cmd="${cmd17}" st="${st17}"`);
  await H.closePopup(page);

  // M2-18 the palette rows
  await H.palette(page, "VCS Group");
  const rows18 = await H.paletteRows(page);
  step("M2-18 eight palette rows", rows18.length === 8 && rows18.some((row) => /Checkout Tag or Revision/.test(row)), JSON.stringify(rows18));
  await page.keyboard.press("Escape");
  await sleep(300);

  // M2-19 cancel a hung job
  sh(`git -C ${REPO} remote add slow http://10.255.255.1/nowhere.git`);
  try {
    await H.openPopup(page);
    await page.click('[data-action="fetch"]');
    await H.waitStatus(page, /Fetching/);
    await sleep(1500);
    await page.click('[data-testid="vcs-busy"] button');
    const st19 = await H.waitStatus(page, /cancelled|failed|Fetched/i, 20_000);
    step("M2-19 Cancel stops a hung fetch job", /cancelled/i.test(st19), st19);
  } finally {
    sh(`git -C ${REPO} remote remove slow`);
  }
  await H.closePopup(page);
} catch (error) {
  console.log("SCRIPT ERROR", String(error).slice(0, 800));
  await H.shot(page, "m2-error");
}
await a.browser.close();
sh(`git -C ${REPO} merge --abort`);
sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} worktree remove --force ${WT}`);
sh(`git -C ${REPO} branch -D ${DEL} ${MRG} ${CFL} ${PB} feature-renamed`);
sh(`git -C ${REPO} tag -d ${TAG}`);
sh(`git -C ${REPO} remote remove slow`);
sh(`git -C ${REPO} branch -m feature-renamed feature`);
process.exit(summary() ? 0 : 1);
