// Composes docs/screenshots/popup-combo.png, the one image in the README's
// "Popup" section: the branch popup, the menu on a branch row, and the New
// Branch and Checkout Tag or Revision dialogs, on one backdrop.
//
//   node scripts/popup-combo.mjs
//
// Like scripts/hero.mjs it photographs a local HTML page, so it needs system
// Chromium and puppeteer-core but no running bb. The four shots it reads are
// hand-taken; retake one and re-run this.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const OUT = `${ROOT}docs/screenshots/popup-combo.png`;
const SCALE = 2;

const file = (path) => `file://${ROOT}${path}`;

// Two by two rather than one row: at the width the README gives this image,
// a four-across strip would print the menu labels too small to read. The
// popup and the menu share an aspect ratio, so the top row ends level.
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #0d0f14; }
  .sheet {
    display: inline-block;
    padding: 36px;
    background: linear-gradient(160deg, #151922, #0d0f14 70%);
  }
  .grid {
    display: grid;
    grid-template-columns: 472px 472px;
    gap: 24px;
    align-items: start;
  }
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
</style>
<div class="sheet">
  <div class="grid">
    <div class="card"><img src="${file("docs/screenshots/popup.png")}"></div>
    <div class="card"><img src="${file("docs/screenshots/branch-menu.png")}"></div>
    <div class="card"><img src="${file("docs/screenshots/new-branch.png")}"></div>
    <div class="card"><img src="${file("docs/screenshots/checkout-revision.png")}"></div>
  </div>
</div>
`;

const PAGE = `${tmpdir()}/vcs-widget-popup-combo.html`;
writeFileSync(PAGE, html);

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: "new",
  args: [`--force-device-scale-factor=${SCALE}`, "--hide-scrollbars"],
  defaultViewport: { width: 1200, height: 600, deviceScaleFactor: SCALE },
});
try {
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`, { waitUntil: "networkidle0" });
  const sheet = await page.$(".sheet");
  await sheet.screenshot({ path: OUT });
  const { width, height } = await sheet.boundingBox();
  console.log(`${OUT} (${width * SCALE}x${height * SCALE})`);
} finally {
  await browser.close();
}
