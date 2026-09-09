// Headless click-through of the VCS Widget popup against a running bb.
//
//   node scripts/live-check.mjs setup <repo>      create <repo>, <repo>.git (bare) and <repo>-clone2
//   npm install --no-save puppeteer-core
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check.mjs run <repo>
//
// See docs/VERIFY.md for the scenario list. Needs system Chromium
// (CHROMIUM, default /usr/bin/chromium) and bb at BB_SERVER_URL. Milestone 2
// scenarios live in live-check-m2.mjs; both share live-lib.mjs.
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { GIT_ID, browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const [, , mode, repoArg] = process.argv;
if (!mode || !repoArg) {
  console.error("usage: live-check.mjs setup|run <repo path>");
  process.exit(2);
}
const REPO = repoArg;
const BARE = `${REPO}.git`;
const CLONE2 = `${REPO}-clone2`;

if (mode === "setup") {
  const cmds = [
    `git init -q -b main ${REPO}`,
    `cd ${REPO} && echo a > a.txt && git add a.txt && git ${GIT_ID} commit -qm first`,
    `cd ${REPO} && echo b > b.txt && git add b.txt && git ${GIT_ID} commit -qm second`,
    `git clone -q --bare ${REPO} ${BARE}`,
    `git -C ${REPO} remote add origin ${BARE}`,
    `git -C ${REPO} push -q -u origin main`,
    `git -C ${REPO} branch feature && git -C ${REPO} push -q origin feature`,
    `git -C ${REPO} branch feat/click-test && git -C ${REPO} push -q origin feat/click-test && git -C ${REPO} branch -D feat/click-test`,
    `git clone -q ${BARE} ${CLONE2}`,
  ];
  for (const cmd of cmds) {
    console.log("$", cmd);
    const out = sh(cmd);
    if (out.startsWith("ERR")) {
      console.error(out);
      process.exit(1);
    }
  }
  console.log(`\nNow create a bb thread whose environment is ${REPO} and run with VCS_E2E_THREAD/VCS_E2E_PROJECT set.`);
  process.exit(0);
}

const H = await browserHelpers();
const { THREAD, launch, label, waitLabel, openPopup, popupText, statusText, bannerTexts, closePopup, waitStatus, waitToast, dialogCmd, dialogText, dialogButton, palette, paletteRows, clickPaletteRow, shot } = H;
const { results, step, summary } = recorder();
const TS = Date.now().toString(36);
const LIVE = `feat/live-${TS}`;
const NOCO = `feat/nocheckout-${TS}`;
const current = () => sh(`git -C ${REPO} branch --show-current`);
const lock = `${REPO}/.git/index.lock`;

sh(`git -C ${REPO} switch -q main`);
const a = await launch("a");
const page = a.page;
try {
  step("S1 button + label main", (await label(page)) === "main", `label=${await label(page)}`);

  await openPopup(page);
  const t2 = await popupText(page);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "");
  step("S2 popup groups and focus", /Actions/.test(t2) && /Local/.test(t2) && /Remote/.test(t2) && /Search/.test(focused), t2.slice(0, 160));
  await shot(page, "s2-popup");
  await page.keyboard.type("click-test");
  await sleep(500);
  const t2b = await popupText(page);
  step("S2b filter hides an empty Local heading", !/\| Local \|/.test(t2b) && /origin\/feat\/click-test/.test(t2b), t2b.slice(0, 120));
  await closePopup(page);

  await openPopup(page);
  step("S2c reopened popup starts unfiltered", /Local/.test(await popupText(page)));
  await page.click('[data-branch-name="origin/feat/click-test"]');
  const ok3 = await waitLabel(page, "feat/click-test");
  await sleep(800);
  step("S3 checkout remote branch", ok3 && current() === "feat/click-test" && sh(`git -C ${REPO} rev-parse --abbrev-ref @{upstream}`) === "origin/feat/click-test");

  await openPopup(page);
  await page.click('[data-action="new-branch"]');
  await page.waitForSelector('form[aria-label="New branch"]', { timeout: 5000 });
  await page.type('input[aria-label="New branch name"]', "bad name");
  await sleep(200);
  const disabled4 = await page.$eval('form[aria-label="New branch"] button[type="submit"]', (e) => e.disabled);
  step("S4a bad name blocks Create", disabled4);
  await page.keyboard.press("Escape");
  await sleep(500);
  step("S4b Escape returns to the list", !!(await page.$('[data-testid="vcs-branch-popup"] input[aria-label="Search for branches and actions"]')));
  await page.click('[data-action="new-branch"]');
  await page.waitForSelector('form[aria-label="New branch"]', { timeout: 5000 });
  await page.type('input[aria-label="New branch name"]', LIVE);
  await page.keyboard.press("Enter");
  step("S4c create with checkout", (await waitLabel(page, LIVE)) && current() === LIVE);
  await sleep(500);
  await openPopup(page);
  await page.click('[data-action="new-branch"]');
  await page.waitForSelector('form[aria-label="New branch"]', { timeout: 5000 });
  await page.type('input[aria-label="New branch name"]', NOCO);
  await page.evaluate(() => document.querySelector('form[aria-label="New branch"] [role="checkbox"]')?.click());
  await sleep(200);
  await page.keyboard.press("Enter");
  const st4 = await waitStatus(page, /Created feat\/nocheckout/);
  step("S4d create without checkout keeps the popup", /Created/.test(st4) && current() === LIVE && !!(await page.$('[data-testid="vcs-branch-popup"]')), st4);
  await closePopup(page);

  await openPopup(page);
  await page.click('[data-action="update"]');
  const st5 = await waitStatus(page, /upstream/i);
  step("S5 update without upstream -> no_upstream", /no upstream/i.test(st5), st5);
  await closePopup(page);

  // COS-128: the outcome outlives the popup for a minute. Past five seconds it
  // is dated and the repository summary joins it underneath, so the wait here
  // is what makes the check deterministic rather than padding.
  await sleep(6000);
  await openPopup(page);
  const st6pre = await statusText(page);
  step(
    "S6pre reopen keeps the last outcome, dated, above the summary",
    /upstream/i.test(st6pre) && / ago/.test(st6pre) && st6pre.split(" | ").length >= 2,
    `status="${st6pre}"`,
  );
  await page.click('[data-action="push"]');
  const cmd6 = await dialogCmd(page);
  await dialogButton(page, "Cancel");
  await sleep(800);
  step("S6a push dialog + cancel", cmd6 === "git push --no-progress -u --end-of-options origin HEAD" && sh(`git ls-remote --heads ${BARE} ${LIVE}`) === "", `cmd="${cmd6}"`);
  await closePopup(page);
  await openPopup(page);
  await page.click('[data-action="push"]');
  await dialogCmd(page);
  await dialogButton(page, "Push");
  await sleep(3500);
  step("S6b push confirm sets upstream", sh(`git -C ${REPO} rev-parse --abbrev-ref @{upstream}`) === `origin/${LIVE}`);
  await closePopup(page);
  sh(`cd ${REPO} && echo live > live.txt && git add live.txt && git ${GIT_ID} commit -qm "live work"`);
  await sleep(5000);
  await openPopup(page);
  await page.click('[data-action="push"]');
  const cmd6c = await dialogCmd(page);
  await dialogButton(page, "Push");
  await sleep(3500);
  step("S6c tracked push by explicit refspec", cmd6c === `git push --no-progress --end-of-options origin HEAD:refs/heads/${LIVE}` && sh(`git --git-dir=${BARE} rev-parse ${LIVE}`) === sh(`git -C ${REPO} rev-parse HEAD`), `cmd="${cmd6c}"`);
  await closePopup(page);
  sh(`git -C ${CLONE2} push -q origin --delete ${LIVE}`);
  await openPopup(page);
  await page.click('[data-action="fetch"]');
  await waitStatus(page, /Fetched/);
  await sleep(500);
  const st6d = await statusText(page);
  await page.click('[data-action="push"]');
  const cmd6d = await dialogCmd(page);
  const dlg6d = await dialogText(page);
  await dialogButton(page, "Cancel");
  await sleep(800);
  step("S6d gone upstream: banner + push offers -u", /gone/i.test(st6d) && /-u --end-of-options origin HEAD$/.test(cmd6d || "") && /no longer exists/.test(dlg6d), `status="${st6d}"`);
  await closePopup(page);

  writeFileSync(lock, "");
  try {
    await openPopup(page);
    const banner7 = await statusText(page);
    await page.click('[data-branch-name="main"]');
    // The row explains client-side (toast) while the overview reports a lock; nothing reaches git.
    const st7 = await waitToast(page, /index lock/i, 10_000);
    step("S7a index.lock -> banner on open + click refused", /lock/i.test(banner7) && /index lock/i.test(st7) && current() === LIVE, `banner="${banner7}" toast="${st7}"`);
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  await closePopup(page);
  // Same six seconds. The banners live inside the status region, so reading
  // them separately is the only way to see that the lock banner went while
  // the last outcome stayed. The refused click itself is not one: a blocked
  // row explains by toast and never writes the status line.
  await sleep(6000);
  await openPopup(page);
  const banners7b = await bannerTexts(page);
  const st7b = await statusText(page);
  step(
    "S7b reopen refetches: the lock banner goes, the last outcome stays dated",
    !banners7b.some((text) => /lock/i.test(text)) && / ago/.test(st7b),
    `banners=${JSON.stringify(banners7b)} status="${st7b}"`,
  );
  await closePopup(page);

  sh(`git -C ${REPO} checkout -q --detach`);
  await sleep(7000);
  const lbl8 = await label(page);
  await openPopup(page);
  step("S8a external detach", /Detached HEAD/.test(await popupText(page)) && /^[0-9a-f]{7}$/.test(lbl8), `label="${lbl8}"`);
  sh(`git -C ${REPO} switch -q main`);
  await sleep(7000);
  const t8b = await popupText(page);
  step("S8b external switch refreshes the open popup", !/Detached HEAD/.test(t8b) && /Local \| main/.test(t8b));
  await closePopup(page);
  step("S8c label after external switch", (await label(page)) === "main");

  sh(`cd ${CLONE2} && git pull -q && echo more > d-${TS}.txt && git add . && git ${GIT_ID} commit -qm "fourth from clone2" && git push -q origin main`);
  await openPopup(page);
  await page.click('[data-action="update"]');
  const st9 = await waitStatus(page, /Update Project|Updated/i);
  step("S9 update ff-only says Fast-forward", /Fast-forward/.test(st9) && sh(`git -C ${REPO} log -1 --format=%s`) === "fourth from clone2", st9);
  await closePopup(page);

  await palette(page, "VCS Widget");
  const rows10 = await paletteRows(page);
  step("S10a eight palette rows", rows10.length === 8, JSON.stringify(rows10));
  await clickPaletteRow(page, "Open branches");
  await sleep(1500);
  step("S10b palette opens popup", !!(await page.$('[data-testid="vcs-branch-popup"]')));
  await closePopup(page);
  await page.keyboard.press("Escape");
  await sleep(300);
  await palette(page, "VCS Widget: Push");
  await clickPaletteRow(page, "VCS Widget: Push");
  const cmd10 = await dialogCmd(page);
  await dialogButton(page, "Cancel");
  await sleep(600);
  step("S10c palette Push previews the tracked refspec", cmd10 === "git push --no-progress --end-of-options origin HEAD:refs/heads/main", `cmd="${cmd10}"`);
  await closePopup(page);
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent("vcs-widget:open", { detail: { threadId: t, action: "fetch" } })), THREAD);
  await sleep(1500);
  step("S10d foreign window event with detail is ignored", !(await page.$('[data-testid="vcs-branch-popup"]')) && !(await page.$('[data-testid="vcs-command-preview"]')));

  const b = await launch("b");
  try {
    await openPopup(b.page);
    const before11 = await popupText(b.page);
    await openPopup(page);
    await page.click('[data-branch-name="feature"]');
    const ok11 = await waitLabel(page, "feature");
    await sleep(5000);
    const after11 = await popupText(b.page);
    step("S11 second client refreshes via realtime", ok11 && /Local \| feature/.test(after11) && !/Local \| feature/.test(before11) && (await label(b.page)) === "feature");
  } catch (error) {
    step("S11 second client", false, String(error).slice(0, 200));
  }
  await b.browser.close();
  await closePopup(page);

  await page.setViewport({ width: 520, height: 800 });
  await sleep(2000);
  const compactAria = await page.$eval('[data-testid="vcs-branch-button"]', (e) => e.getAttribute("aria-label")).catch(() => null);
  step("S12 compact viewport icon-only", (await label(page)) === "" && /^Git branch: /.test(compactAria || ""), `aria="${compactAria}"`);
  await shot(page, "s12-compact");
} catch (error) {
  console.log("SCRIPT ERROR", String(error).slice(0, 600));
  await shot(page, "error");
}
await a.browser.close();
if (existsSync(lock)) unlinkSync(lock);
sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} branch -D ${LIVE} ${NOCO} feat/click-test`);
sh(`git -C ${CLONE2} pull -q`);
void results;
process.exit(summary() ? 0 : 1);
