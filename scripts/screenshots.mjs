// Regenerates the README images from a running bb, so they can be refreshed
// instead of redrawn:
//
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/screenshots.mjs
//
// With no argument it only photographs what the thread already shows and
// never touches git — point it at a thread whose worktree has a couple of
// uncommitted changes and a readable history. Pass the scratch repository
// path to have it stage a change first (it resets that repository, so never
// pass one you care about).
//
// Writes docs/screenshots/*.png. Needs system Chromium and puppeteer-core,
// like the live checks (see docs/VERIFY.md). The diff viewer is left
// unopened on purpose: headless Chromium has no code theme registered, so it
// would photograph as an empty pane.
import { mkdirSync } from "node:fs";
import { GIT_ID, browserHelpers, sh, sleep } from "./live-lib.mjs";

const SCRATCH = process.argv[2] ?? null;
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const H = await browserHelpers();
const BASE = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";

if (SCRATCH !== null) {
  sh(`git -C ${SCRATCH} switch -q main`);
  sh(`git -C ${SCRATCH} reset -q --hard origin/main`);
  sh(`git -C ${SCRATCH} clean -fdq`);
  sh(`cd ${SCRATCH} && printf 'a change\\n' >> a.txt && printf 'new file\\n' > notes.txt && git ${GIT_ID} add a.txt`);
}

const { browser, page } = await H.launch("shots");
const clip = async (name, selector) => {
  const element = await page.$(selector);
  if (element === null) return console.log(`skipped ${name}: ${selector} not found`);
  await element.screenshot({ path: `${OUT}${name}.png` });
  console.log(`${OUT}${name}.png`);
};

try {
  await H.openPopup(page);
  await sleep(1200);
  await clip("popup", '[data-testid="vcs-branch-popup"]');

  await page.click('[data-testid="vcs-branch-popup"] [data-action="commit"]');
  await page.waitForSelector('[data-testid="vcs-commit-panel"]', { timeout: 20_000 });
  await sleep(2500);
  await page.click('[data-testid="vcs-commit-panel"] [data-testid="vcs-commit-message"]');
  await page.keyboard.type("Milestone 5: settings sections, a read-only CLI and agent tool");
  await sleep(500);
  await clip("commit", '[data-testid="vcs-commit-panel"]');

  await H.openPopup(page);
  await page.click('[data-testid="vcs-branch-popup"] [data-action="log"]');
  await page.waitForSelector('[data-testid="vcs-log-panel"]', { timeout: 20_000 });
  await sleep(2500);
  await page.click('[data-testid="vcs-log-panel"] [data-sha]').catch(() => {});
  await sleep(2000);
  await clip("log", '[data-testid="vcs-log-panel"]');

  await page.goto(`${BASE}/settings/plugins/vcs-widget`, { waitUntil: "load", timeout: 60_000 });
  await sleep(4000);
  // Scroll past part of bb's own form so both plugin sections fit in frame.
  await page.mouse.move(900, 500);
  await page.mouse.wheel({ deltaY: 420 });
  await sleep(1000);
  await page.screenshot({ path: `${OUT}settings.png` });
  console.log(`${OUT}settings.png`);
} finally {
  await browser.close();
  if (SCRATCH !== null) {
    sh(`git -C ${SCRATCH} reset -q --hard origin/main`);
    sh(`git -C ${SCRATCH} clean -fdq`);
  }
}
