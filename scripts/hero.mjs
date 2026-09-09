// Composes docs/screenshots/hero.png, the README's header image: the thread
// header bar, the branch popup, and the commit and log panels either side,
// laid on docs/hero/background.jpg.
//
//   node scripts/hero.mjs
//
// It photographs a local HTML page, so it needs system Chromium and
// puppeteer-core but no running bb. Refresh the panel shots with
// scripts/screenshots.mjs first if the UI has moved on.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const OUT = `${ROOT}docs/screenshots/hero.png`;
const W = 1200;
const H = 600;

const file = (path) => `file://${ROOT}${path}`;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; }
  .bg {
    position: absolute; inset: 0;
    background: url("${file("docs/hero/background.jpg")}") center / cover;
  }
  /* The panels are dark UI on a bright gradient; the scrim keeps the corners
     dark enough for their shadows to read. */
  .scrim {
    position: absolute; inset: 0;
    background:
      radial-gradient(130% 105% at 50% 38%, rgba(8, 10, 16, 0.06), rgba(8, 10, 16, 0.62));
  }
  .card {
    position: absolute;
    border-radius: 12px;
    overflow: hidden;
    background: #171b23;
    box-shadow:
      0 2px 4px rgba(0, 0, 0, 0.35),
      0 28px 60px -14px rgba(0, 0, 0, 0.72),
      0 0 0 1px rgba(255, 255, 255, 0.10);
  }
  .card img { display: block; width: 100%; height: auto; }
  /* One grid: the header bar spans the row, the three cards sit on one
     baseline under it, the popup centred and a size larger. */
  .header { left: 90px;  top: 44px;  width: 1020px; border-radius: 10px; }
  .commit { left: 90px;  top: 165px; width: 246px; }
  .log    { left: 864px; top: 165px; width: 246px; }
  .popup  { left: 440px; top: 183px; width: 320px; border-radius: 10px; }
</style>
<div class="bg"></div>
<div class="scrim"></div>
<div class="card commit"><img src="${file("docs/screenshots/commit.png")}"></div>
<div class="card log"><img src="${file("docs/screenshots/log.png")}"></div>
<div class="card header"><img src="${file("docs/hero/header.png")}"></div>
<div class="card popup"><img src="${file("docs/screenshots/popup.png")}"></div>
`;

const PAGE = `${tmpdir()}/vcs-widget-hero.html`;
writeFileSync(PAGE, html);

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: "new",
  args: ["--no-sandbox", "--force-device-scale-factor=1.6", "--hide-scrollbars"],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1.6 },
});
try {
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: OUT });
  console.log(`${OUT} (${W * 1.6}x${H * 1.6})`);
} finally {
  await browser.close();
}
