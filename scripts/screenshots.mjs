// Refreshes the branch popup shot from a running bb, so it can be retaken
// instead of redrawn:
//
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/screenshots.mjs
//
// With no argument it only photographs what the thread already shows and
// never touches git. Pass the scratch repository path to have it stage a
// change first (it resets that repository, so never pass one you care
// about).
//
// Writes docs/screenshots/popup.png, which scripts/combos.mjs and
// scripts/hero.mjs then compose into the README's images. Needs system
// Chromium and puppeteer-core, like the live checks (see docs/VERIFY.md).
//
// It is the only shot left on the list. The commit panel is worth showing
// with a diff open, which headless Chromium photographs as an empty pane for
// want of a code theme; the git log with a real history and a message that
// fills the detail pane, which a scratch repository has not got; the settings
// page with the sections read end to end. Those are hand-taken, and this
// script must not overwrite them.
import { mkdirSync } from "node:fs";
import { GIT_ID, browserHelpers, sh, sleep } from "./live-lib.mjs";

const SCRATCH = process.argv[2] ?? null;
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const H = await browserHelpers();

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
} finally {
  await browser.close();
  if (SCRATCH !== null) {
    sh(`git -C ${SCRATCH} reset -q --hard origin/main`);
    sh(`git -C ${SCRATCH} clean -fdq`);
  }
}
