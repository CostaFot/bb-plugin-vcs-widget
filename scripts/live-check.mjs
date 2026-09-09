// Headless click-through of the VCS Group popup against a running bb.
//
//   node scripts/live-check.mjs setup <repo>      create <repo>, <repo>.git (bare) and <repo>-clone2
//   npm install --no-save puppeteer-core
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check.mjs run <repo>
//
// See docs/VERIFY.md for the scenario list. Needs system Chromium
// (CHROMIUM, default /usr/bin/chromium) and bb at BB_SERVER_URL.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** puppeteer-core from the working directory's node_modules (not a dependency of the plugin). */
async function loadPuppeteer() {
  try {
    return (await import("puppeteer-core")).default;
  } catch {
    const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    return (await import(pathToFileURL(require.resolve("puppeteer-core")).href)).default;
  }
}

const [, , mode, repoArg] = process.argv;
if (!mode || !repoArg) {
  console.error("usage: live-check.mjs setup|run <repo path>");
  process.exit(2);
}
const REPO = repoArg;
const BARE = `${REPO}.git`;
const CLONE2 = `${REPO}-clone2`;
const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `ERR(${error.status}): ${(error.stderr || "").trim()}`;
  }
};
const GIT_ID = "-c user.name=vcs -c user.email=vcs@example.com";

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

const THREAD = process.env.VCS_E2E_THREAD;
const PROJECT = process.env.VCS_E2E_PROJECT;
const BASE = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
if (!THREAD || !PROJECT) {
  console.error("set VCS_E2E_THREAD and VCS_E2E_PROJECT");
  process.exit(2);
}
const puppeteer = await loadPuppeteer().catch(() => {
  console.error("puppeteer-core not found: run `npm install --no-save puppeteer-core` in the plugin directory first");
  process.exit(2);
});
mkdirSync("/tmp/vcs-e2e", { recursive: true });

const TS = Date.now().toString(36);
const LIVE = `feat/live-${TS}`;
const NOCO = `feat/nocheckout-${TS}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
const step = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
async function launch(tag, width = 1400) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    protocolTimeout: 90_000,
    args: ["--no-sandbox", "--disable-gpu", `--window-size=${width},900`, `--user-data-dir=/tmp/vcs-e2e/profile-${tag}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  page.on("pageerror", (error) => console.log(`[${tag} pageerror]`, String(error).slice(0, 300)));
  await page.goto(`${BASE}/projects/${PROJECT}/threads/${THREAD}`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('[data-testid="vcs-branch-button"]', { timeout: 30_000 });
  await sleep(1500);
  return { browser, page };
}
const label = (page) => page.$eval('[data-testid="vcs-branch-button"]', (e) => e.textContent.trim());
async function waitLabel(page, want, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await label(page)) === want) return true;
    await sleep(300);
  }
  return false;
}
async function openPopup(page) {
  if (await page.$('[data-testid="vcs-branch-popup"]')) return;
  await page.click('[data-testid="vcs-branch-button"]');
  await page.waitForSelector('[data-testid="vcs-branch-popup"]', { timeout: 15_000 });
  await sleep(1500);
}
const popupText = async (page) => (await page.$eval('[data-testid="vcs-branch-popup"]', (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
const statusText = async (page) => (await page.$eval('[data-testid="vcs-branch-popup"] [role="status"]', (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
async function closePopup(page) {
  for (let i = 0; i < 3 && (await page.$('[data-testid="vcs-branch-popup"]')); i += 1) {
    await page.keyboard.press("Escape");
    await sleep(500);
  }
}
async function waitStatus(page, re, ms = 25_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await statusText(page);
    if (re.test(last)) return last;
    await sleep(300);
  }
  return `TIMEOUT last="${last}"`;
}
async function dialogCmd(page) {
  const el = await page.waitForSelector('[data-testid="vcs-command-preview"]', { timeout: 10_000 }).catch(() => null);
  return el ? await el.evaluate((e) => e.textContent) : null;
}
const dialogText = async (page) => (await page.$eval('[role="alertdialog"]', (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
async function dialogButton(page, text) {
  for (const button of await page.$$('[role="alertdialog"] button')) {
    if ((await button.evaluate((e) => e.textContent.trim())) === text) {
      await button.click();
      return true;
    }
  }
  return false;
}
async function palette(page, query) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(900);
  await page.keyboard.type(query);
  await sleep(800);
}
const paletteRows = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[cmdk-item], [role="option"]')].map((e) => e.innerText.replace(/\n+/g, " ")).filter((t) => /VCS Group:/.test(t)));
async function clickPaletteRow(page, source) {
  const handle = await page.evaluateHandle((src) => [...document.querySelectorAll('[cmdk-item], [role="option"]')].find((e) => new RegExp(src).test(e.innerText)), source);
  if (handle && handle.asElement()) await handle.asElement().click();
}
const current = () => sh(`git -C ${REPO} branch --show-current`);
const shot = (page, name) => page.screenshot({ path: `/tmp/vcs-e2e/${name}.png` }).catch(() => {});
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

  await openPopup(page);
  step("S6pre reopen clears the last status", !/upstream branch/i.test(await statusText(page)));
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
    const st7 = await waitStatus(page, /locked/i, 10_000);
    step("S7a index.lock -> banner on open + index_locked", /lock/i.test(banner7) && /locked/i.test(st7) && current() === LIVE, `banner="${banner7}"`);
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
  await closePopup(page);
  await openPopup(page);
  step("S7b reopen refetches: lock banner and last error gone", !/lock/i.test(await statusText(page)));
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

  await palette(page, "VCS Group");
  const rows10 = await paletteRows(page);
  step("S10a five palette rows", rows10.length === 5, JSON.stringify(rows10));
  await clickPaletteRow(page, "Open branches");
  await sleep(1500);
  step("S10b palette opens popup", !!(await page.$('[data-testid="vcs-branch-popup"]')));
  await closePopup(page);
  await page.keyboard.press("Escape");
  await sleep(300);
  await palette(page, "VCS Group: Push");
  await clickPaletteRow(page, "VCS Group: Push");
  const cmd10 = await dialogCmd(page);
  await dialogButton(page, "Cancel");
  await sleep(600);
  step("S10c palette Push previews the tracked refspec", cmd10 === "git push --no-progress --end-of-options origin HEAD:refs/heads/main", `cmd="${cmd10}"`);
  await closePopup(page);
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent("vcs-group:open", { detail: { threadId: t, action: "fetch" } })), THREAD);
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
console.log("=====SUMMARY=====");
for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}`);
process.exit(results.every((result) => result.pass) ? 0 : 1);
