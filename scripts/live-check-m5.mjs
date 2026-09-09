// Headless click-through of milestone 5 against a running bb: the read-only
// `bb vcs-widget` command against the scratch repository, the two settings
// sections on the plugin's own page (including clearing a favourite the popup
// starred), and a phone-width pass over the button, the popup and the panels.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m5.mjs /tmp/vcs-scratch
//
// The CLI half needs `bb` on PATH and the thread from VCS_E2E_THREAD; the rest
// needs system Chromium and puppeteer-core in node_modules. See docs/VERIFY.md.
import { GIT_ID, browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m5.mjs <repo path>");
  process.exit(2);
}
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const SIDE = `m5-${TS}`;
const SUBJECT = `Settings check ${TS}`;
const BASE = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
const SETTINGS = `${BASE}/settings/plugins/vcs-widget`;
const cli = (args) => sh(`bb vcs-widget ${args} --thread ${H.THREAD}`);

// A known state: main at origin plus one side branch with one commit.
sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} clean -fdq`);
sh(`git -C ${REPO} branch -D ${SIDE}`);
sh(`git -C ${REPO} switch -q -c ${SIDE}`);
sh(`cd ${REPO} && echo m5 > m5-${TS}.txt && git ${GIT_ID} add m5-${TS}.txt && git ${GIT_ID} commit -q -m "${SUBJECT}"`);
const sideSha = sh(`git -C ${REPO} rev-parse --short=7 HEAD`);
sh(`git -C ${REPO} switch -q main`);

try {
  // ---------------------------------------------------------------------
  // The command
  // ---------------------------------------------------------------------
  const status = cli("status");
  step(
    "M5-1 `status` names the repository, the branch and its upstream",
    new RegExp(`Repository: .*${REPO.split("/").pop()}`).test(status) && /HEAD: +main \(/.test(status) && /Upstream: +origin\/main/.test(status),
    status.split("\n")[1] ?? status.slice(0, 120),
  );

  sh(`cd ${REPO} && echo dirty >> a.txt && echo untracked > u-${TS}.txt`);
  const dirty = cli("status");
  sh(`git -C ${REPO} checkout -q -- a.txt`);
  sh(`rm -f ${REPO}/u-${TS}.txt`);
  step("M5-2 `status` counts the working tree", /Working: +1 unstaged, 1 untracked/.test(dirty), (dirty.match(/Working:.*/) ?? [""])[0]);

  const branches = cli("branches --all");
  step(
    "M5-3 `branches --all` marks the current branch and lists the remote ones",
    /^\* main /m.test(branches) && new RegExp(`^ {2}${SIDE} `, "m").test(branches) && /Remote branches \(/.test(branches) && /origin\/main/.test(branches),
    branches.split("\n")[1] ?? "",
  );

  const log = cli(`log --branch ${SIDE} --limit 3`);
  step("M5-4 `log --branch` walks that branch", log.startsWith(sideSha) && log.includes(SUBJECT), log.split("\n")[0] ?? "");

  const grep = cli(`log --all --grep "${SUBJECT}"`);
  step("M5-5 `log --grep` is a literal filter", grep.split("\n").length === 1 && grep.includes(SUBJECT), grep.slice(0, 120));

  const json = cli("status --json");
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    /* reported below */
  }
  step(
    "M5-6 `--json` prints bounded data: counts, not the branch arrays",
    parsed !== null && parsed.local === undefined && typeof parsed.branchCounts?.local === "number" && parsed.head?.name === "main",
    json.slice(0, 120),
  );

  const unknown = sh(`bb vcs-widget checkout main --thread ${H.THREAD} 2>&1; echo "exit=$?"`);
  const badBranch = sh(`bb vcs-widget log --branch "bad name" --thread ${H.THREAD} 2>&1; echo "exit=$?"`);
  const noRepo = sh(`bb vcs-widget status --thread thr_definitelynotathread 2>&1; echo "exit=$?"`);
  step(
    "M5-7 there is no mutating command; usage errors exit 2 and a missing repository exits 1",
    /Unknown command "checkout"/.test(unknown) && unknown.includes("exit=2") && badBranch.includes("exit=2") && noRepo.includes("exit=1"),
    `${unknown.split("\n")[0]} / ${noRepo.split("\n")[0]}`,
  );

  // ---------------------------------------------------------------------
  // The settings page
  // ---------------------------------------------------------------------
  const a = await H.launch("m5");
  const page = a.page;

  // Star a branch so the favourites section has something to show.
  await H.openPopup(page);
  await page.click(`[data-branch-name="${SIDE}"] [aria-label="Add ${SIDE} to favourites"]`).catch(() => {});
  await sleep(1200);
  await H.closePopup(page);

  await page.goto(SETTINGS, { waitUntil: "load", timeout: 60_000 });
  await sleep(3000);
  const settingsText = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ");
  const settings = await settingsText();
  await H.shot(page, "m5-settings");
  step(
    "M5-8 the settings page carries bb's form and both plugin sections",
    /Update Project strategy/.test(settings) && /Agent access/.test(settings) && /Favourite branches/.test(settings),
    settings.slice(0, 200),
  );
  step(
    "M5-9 the agent access section names the read-only surfaces",
    /bb vcs-widget status/.test(settings) && /vcs_widget_status/.test(settings) && /Both only read/.test(settings),
    "",
  );

  const listed = /Favourite branches/.test(settings) && settings.includes(REPO) && settings.includes(SIDE);
  const clear = await page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Clear"));
  const hasClear = Boolean(clear && clear.asElement());
  if (hasClear) await clear.asElement().click();
  await sleep(1500);
  const cleared = await settingsText();
  step(
    "M5-10 the favourites section lists the worktree the popup starred and clears it",
    listed && hasClear && /No favourites yet/.test(cleared),
    `listed=${listed} button=${hasClear}`,
  );
  await H.shot(page, "m5-settings-cleared");
  await a.browser.close();

  // ---------------------------------------------------------------------
  // Phone width
  // ---------------------------------------------------------------------
  const b = await H.launch("m5-compact", 390);
  const phone = b.page;
  const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // A panel tab covers the header on a phone, so each panel check starts from
  // a reloaded thread page rather than from whatever the last one left open.
  const freshPopup = async () => {
    await phone.goto(`${BASE}/projects/${H.PROJECT}/threads/${H.THREAD}`, { waitUntil: "load", timeout: 60_000 });
    await phone.waitForSelector('[data-testid="vcs-branch-button"]', { timeout: 30_000 });
    await sleep(1500);
    await phone.click('[data-testid="vcs-branch-button"]');
    await phone.waitForSelector('[data-testid="vcs-branch-popup"]', { visible: true, timeout: 15_000 });
    await sleep(1500);
  };

  const buttonText = await H.label(phone);
  step("M5-11 the branch button is icon-only at phone width", buttonText === "", `label="${buttonText}"`);

  await freshPopup();
  const popupFits = await phone.evaluate(() => {
    const popup = document.querySelector('[data-testid="vcs-branch-popup"]');
    if (!popup) return null;
    const box = popup.getBoundingClientRect();
    return box.left >= -1 && box.right <= window.innerWidth + 1;
  });
  await H.shot(phone, "m5-compact-popup");
  step("M5-12 the popup stays inside a 390px viewport", popupFits === true && (await overflow()) <= 0, `fits=${popupFits} overflow=${await overflow()}`);

  await phone.click('[data-testid="vcs-branch-popup"] [data-action="commit"]');
  await phone.waitForSelector('[data-testid="vcs-commit-panel"]', { timeout: 20_000 }).catch(() => null);
  await sleep(2000);
  const commitOverflow = await overflow();
  await H.shot(phone, "m5-compact-commit");
  step("M5-13 the commit panel does not overflow at phone width", commitOverflow <= 0, `overflow=${commitOverflow}px`);

  await freshPopup();
  await phone.click('[data-testid="vcs-branch-popup"] [data-action="log"]');
  await phone.waitForSelector('[data-testid="vcs-log-panel"]', { timeout: 20_000 }).catch(() => null);
  await sleep(2500);
  const logOverflow = await overflow();
  await H.shot(phone, "m5-compact-log");
  step("M5-14 the log panel does not overflow at phone width", logOverflow <= 0, `overflow=${logOverflow}px`);

  await b.browser.close();
} catch (error) {
  console.error(error);
  step("run completed", false, String(error).slice(0, 200));
}

sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} branch -D ${SIDE}`);
process.exit(summary() ? 0 : 1);
