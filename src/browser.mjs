// Starts Google Chrome as plain Chrome and connects to it.
//
// Letting Playwright launch Chrome adds about 30 switches (--no-sandbox,
// --disable-extensions, --password-store=basic, ...) that make it unlike a
// normal browser, and Instagram refused unsends from such a session while
// accepting them from the phone. Here Chrome gets only a debugging port, its
// profile folder, and the switch that hides navigator.webdriver.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  const candidates = {
    win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] ?? [];
  const found = candidates.find((file) => existsSync(file));
  if (found) return found;
  // Playwright's own Chromium, when it was installed with `npx playwright install chromium`.
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : null;
}

// Chrome writes the port it picked into this file once it is ready.
async function waitForPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) return null;
    try {
      const port = (await readFile(file, 'utf8')).split('\n')[0].trim();
      if (port) return port;
    } catch {
      // Not written yet.
    }
    await sleep(100);
  }
  return null;
}

// Returns { context, close, onClose }. context is the browser's own window
// and tabs, so the Instagram login is kept in profileDir between runs.
export async function launchBrowser(profileDir, { headless = false } = {}) {
  const executable = findChrome();
  if (!executable) throw new Error('No browser found. Install Google Chrome, or run: npx playwright install chromium');

  await mkdir(profileDir, { recursive: true });
  await rm(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    ...(headless ? ['--headless=new'] : []),
    // Chrome cannot sandbox itself when run as root (only happens in containers).
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  // Its own process group on macOS/Linux, so Ctrl+C in the terminal does not kill it.
  const child = spawn(executable, args, { stdio: 'ignore', detached: process.platform !== 'win32' });

  const port = await waitForPort(profileDir, child);
  if (!port) {
    child.kill();
    throw new Error('The browser did not start. If an IG Unsend browser window is still open, close it and try again.');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  // If the tool ends without closing it (an error, the terminal killed), take
  // the browser down with it instead of leaving it running.
  const killOnExit = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', killOnExit);

  const close = async () => {
    process.off('exit', killOnExit);
    if (browser.isConnected()) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      await session?.send('Browser.close').catch(() => {});
    }
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill();
  };
  const onClose = (callback) => browser.on('disconnected', callback);
  return { context, close, onClose };
}
