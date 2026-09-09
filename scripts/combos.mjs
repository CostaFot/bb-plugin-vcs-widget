// Composes the README's two section images, each one sheet of hand-taken
// shots on a backdrop:
//
//   docs/screenshots/popup-combo.png  the branch popup, the menu on a branch
//                                     row, New Branch, Checkout Tag or Revision
//   docs/screenshots/log-combo.png    the git log panel and a commit's menu
//
//   node scripts/combos.mjs [popup|log]
//
// Like scripts/hero.mjs it photographs a local HTML page, so it needs system
// Chromium and puppeteer-core but no running bb. The shots it reads are
// hand-taken; retake one and re-run this.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const SCALE = 2;
const only = process.argv[2] ?? null;

const shot = (name) => `file://${ROOT}docs/screenshots/${name}.png`;
const card = (name) => `<div class="card"><img src="${shot(name)}"></div>`;

const STYLE = `
  html, body { margin: 0; padding: 0; background: #0d0f14; }
  .sheet {
    display: inline-block;
    padding: 36px;
    background: linear-gradient(160deg, #151922, #0d0f14 70%);
  }
  .grid { display: grid; gap: 24px; }
  .card {
    border-radius: 10px;
    overflow: hidden;
    background: #171b23;
    box-shadow:
      0 2px 4px rgba(0, 0, 0, 0.35),
      0 18px 40px -12px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(255, 255, 255, 0.10);
  }
  .card img { display: block; width: 100%; height: auto; }
`;

// popup: two by two rather than one row, because at the width the README
// gives this image a four-across strip would print the menu labels too small
// to read. The popup and the menu share an aspect ratio, so the top row ends
// level.
//
// log: the panel is tall and the menu is not, so the menu sits centred
// beside it. Overlapping the two reads better in principle and worse in
// fact — the menu shot carries its own slice of the log behind it, and the
// rows in it line up with nothing.
const SHEETS = {
  popup: {
    style: ".grid { grid-template-columns: 472px 472px; align-items: start; }",
    body: `<div class="grid">${["popup", "branch-menu", "new-branch", "checkout-revision"].map(card).join("")}</div>`,
  },
  log: {
    style: ".grid { grid-template-columns: 560px 400px; align-items: center; }",
    body: `<div class="grid">${["log", "log-menu"].map(card).join("")}</div>`,
  },
};

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: "new",
  args: [`--force-device-scale-factor=${SCALE}`, "--hide-scrollbars"],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: SCALE },
});
try {
  const page = await browser.newPage();
  for (const [name, sheet] of Object.entries(SHEETS)) {
    if (only !== null && only !== name) continue;
    const html = `<!doctype html>
<meta charset="utf-8">
<style>${STYLE}${sheet.style}
</style>
<div class="sheet">${sheet.body}</div>
`;
    const path = `${tmpdir()}/vcs-widget-${name}-combo.html`;
    writeFileSync(path, html);
    await page.goto(`file://${path}`, { waitUntil: "networkidle0" });
    const element = await page.$(".sheet");
    const out = `${ROOT}docs/screenshots/${name}-combo.png`;
    await element.screenshot({ path: out });
    const { width, height } = await element.boundingBox();
    console.log(`${out} (${width * SCALE}x${height * SCALE})`);
  }
} finally {
  await browser.close();
}
