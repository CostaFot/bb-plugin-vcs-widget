// Shared helpers for the headless click-throughs (live-check.mjs and
// live-check-m2.mjs): a Chromium session on the bb web UI, popup and dialog
// accessors, and a PASS/FAIL recorder.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** puppeteer-core from the working directory's node_modules (not a dependency of the plugin). */
export async function loadPuppeteer() {
  try {
    return (await import("puppeteer-core")).default;
  } catch {
    const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    return (await import(pathToFileURL(require.resolve("puppeteer-core")).href)).default;
  }
}

export const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `ERR(${error.status}): ${(error.stderr || "").trim()}`;
  }
};
export const GIT_ID = "-c user.name=vcs -c user.email=vcs@example.com";
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function recorder() {
  const results = [];
  const step = (name, pass, detail = "") => {
    results.push({ name, pass });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const summary = () => {
    console.log("=====SUMMARY=====");
    for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}`);
    return results.every((result) => result.pass);
  };
  return { results, step, summary };
}

export function environment() {
  const THREAD = process.env.VCS_E2E_THREAD;
  const PROJECT = process.env.VCS_E2E_PROJECT;
  const BASE = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
  const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
  if (!THREAD || !PROJECT) {
    console.error("set VCS_E2E_THREAD and VCS_E2E_PROJECT");
    process.exit(2);
  }
  mkdirSync("/tmp/vcs-e2e", { recursive: true });
  return { THREAD, PROJECT, BASE, CHROMIUM };
}

export async function browserHelpers() {
  const { THREAD, PROJECT, BASE, CHROMIUM } = environment();
  const puppeteer = await loadPuppeteer().catch(() => {
    console.error("puppeteer-core not found: run `npm install --no-save puppeteer-core` in the plugin directory first");
    process.exit(2);
  });

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
  /** Right-clicks a branch row and waits for its context menu. */
  async function openMenu(page, name) {
    await page.click(`[data-branch-name="${name}"]`, { button: "right" });
    await page.waitForSelector('[data-testid="vcs-branch-menu"]', { timeout: 10_000 });
    await sleep(400);
  }
  const menuLabels = (page) =>
    page.evaluate(() => [...document.querySelectorAll('[data-testid="vcs-branch-menu"] [role="menuitem"]')].map((e) => e.innerText.replace(/\n+/g, " ").replace(/F2$/, "").trim()));
  async function clickMenu(page, id) {
    await page.click(`[data-testid="vcs-branch-menu"] [data-menu-id="${id}"]`);
    await sleep(800);
  }
  const shot = (page, name) => page.screenshot({ path: `/tmp/vcs-e2e/${name}.png` }).catch(() => {});
  /** Confirmed actions close the popup and report through a toast. */
  const toastText = (page) => page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((e) => e.innerText.replace(/\n+/g, " ")).join(" | "));
  async function waitToast(page, re, ms = 25_000) {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < ms) {
      last = await toastText(page);
      if (re.test(last)) return last;
      await sleep(300);
    }
    return `TIMEOUT last="${last}"`;
  }

  return {
    THREAD,
    PROJECT,
    launch,
    label,
    waitLabel,
    openPopup,
    popupText,
    statusText,
    closePopup,
    waitStatus,
    dialogCmd,
    dialogText,
    dialogButton,
    palette,
    paletteRows,
    clickPaletteRow,
    openMenu,
    menuLabels,
    clickMenu,
    shot,
    toastText,
    waitToast,
  };
}
