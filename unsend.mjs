#!/usr/bin/env node
// Unsends your own messages in one Instagram DM conversation by driving the
// regular instagram.com web UI in a browser window on your own computer.

import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INBOX_URL = 'https://www.instagram.com/direct/inbox/';

// UI strings in English and Arabic. English is the tested path; switch the
// Instagram web language to English if the Arabic labels do not match.
export const LABELS = {
  more: /^(More|More options|See more options.*|المزيد|خيارات إضافية|المزيد من الخيارات.*)$/i,
  unsend: /^(Unsend|إلغاء الإرسال)$/i,
  blocked: /(try again later|action blocked|we restrict certain activity|حاول مرة أخرى لاحق|تم حظر)/i,
};

const ROW = '[role="row"]';
const SEEN = 'data-unsend-seen';
const CURRENT = 'data-unsend-current';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

async function firstVisible(locator, timeout) {
  const target = locator.filter({ visible: true }).first();
  try {
    await target.waitFor({ state: 'visible', timeout });
    return target;
  } catch {
    return null;
  }
}

// The hover toolbar is either inside the row or rendered next to it, so look
// inside the row first and then for a "More" button level with the row.
async function revealMoreButton(page, row) {
  const box = await row.boundingBox();
  if (!box) return null;

  for (const xRatio of [0.5, 0.8, 0.2]) {
    await page.mouse.move(box.x + box.width * xRatio, box.y + box.height / 2);
    const inRow = await firstVisible(
      row.getByRole('button', { name: LABELS.more }).or(row.getByLabel(LABELS.more)),
      600,
    );
    if (inRow) return inRow;

    const nearby = page.getByRole('button', { name: LABELS.more }).or(page.getByLabel(LABELS.more));
    for (const candidate of await nearby.filter({ visible: true }).all()) {
      const b = await candidate.boundingBox();
      if (!b) continue;
      const centerY = b.y + b.height / 2;
      const centerX = b.x + b.width / 2;
      if (centerY >= box.y - 8 && centerY <= box.y + box.height + 8 && centerX >= box.x && centerX <= box.x + box.width) {
        return candidate;
      }
    }
  }
  return null;
}

async function isBlocked(page) {
  return (await page.getByRole('dialog').filter({ hasText: LABELS.blocked }).filter({ visible: true }).count()) > 0
    || (await page.getByRole('alert').filter({ hasText: LABELS.blocked }).filter({ visible: true }).count()) > 0;
}

// Returns 'skipped' (not yours / nothing to unsend), 'found' (dry run),
// 'unsent', or 'unconfirmed' (the flow completed but the row did not go away).
async function processRow(page, handle, dryRun) {
  await handle.evaluate((el, attr) => el.setAttribute(attr, '1'), CURRENT);
  const row = page.locator(`[${CURRENT}]`);
  try {
    await handle.scrollIntoViewIfNeeded();
    const more = await revealMoreButton(page, row);
    if (!more) return 'skipped';

    await more.click();
    // Once the menu is open, a missing "Unsend" means the message is not yours.
    const menu = await firstVisible(page.locator('[role="menu"], [role="dialog"]'), 2500);
    const unsendItem = await firstVisible(
      page.getByRole('menuitem', { name: LABELS.unsend })
        .or(page.getByRole('button', { name: LABELS.unsend }))
        .or(page.locator('[role="menu"], [role="dialog"]').getByText(LABELS.unsend)),
      menu ? 500 : 1500,
    );
    if (!unsendItem || dryRun) {
      await page.keyboard.press('Escape');
      return unsendItem ? 'found' : 'skipped';
    }

    await unsendItem.click();
    const confirm = await firstVisible(page.getByRole('dialog').getByRole('button', { name: LABELS.unsend }), 3000);
    if (confirm) await confirm.click();

    try {
      await page.waitForFunction((el) => !el.isConnected, handle, { timeout: 6000 });
      return 'unsent';
    } catch {
      return 'unconfirmed';
    }
  } finally {
    await handle.evaluate((el, [current, seen]) => {
      el.removeAttribute(current);
      el.setAttribute(seen, '1');
    }, [CURRENT, SEEN]).catch(() => {});
  }
}

// Scrolls to the oldest loaded message so Instagram loads older ones.
// Returns true when new rows showed up.
async function loadOlder(page, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const before = await page.locator(ROW).count();
    const top = page.locator(ROW).first();
    await top.scrollIntoViewIfNeeded().catch(() => {});
    const box = await top.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -3000);
    }
    await sleep(1500 + i * 1500);
    const unseen = await page.locator(`${ROW}:not([${SEEN}])`).count();
    if (unseen > 0 || (await page.locator(ROW).count()) > before) return true;
  }
  return false;
}

export async function unsendThread(page, options = {}) {
  const {
    dryRun = false,
    limit = Infinity,
    minDelay = 1500,
    maxDelay = 4000,
    breakEvery = 40,
    breakSeconds = 90,
    log = console.log,
  } = options;
  const stats = { unsent: 0, found: 0, skipped: 0, unconfirmed: 0, stoppedBy: 'end of conversation' };
  let failuresInARow = 0;

  await page.locator(ROW).first().waitFor({ timeout: 30000 });

  while (true) {
    if (stats.unsent + stats.found >= limit) {
      stats.stoppedBy = `reached --limit ${limit}`;
      break;
    }
    const next = page.locator(`${ROW}:not([${SEEN}])`).last();
    if ((await next.count()) === 0) {
      if (!(await loadOlder(page))) break;
      continue;
    }

    const result = await processRow(page, await next.elementHandle(), dryRun);
    stats[result]++;

    if (await isBlocked(page)) {
      stats.stoppedBy = 'Instagram showed a "try again later" / action blocked message';
      break;
    }

    if (result === 'unconfirmed') {
      if (++failuresInARow >= 5) {
        stats.stoppedBy = '5 unsends in a row did not remove the message; run --inspect and check the labels';
        break;
      }
    } else if (result === 'unsent') {
      failuresInARow = 0;
    }

    if (result === 'unsent' || result === 'found') {
      const done = stats.unsent + stats.found;
      log(`${dryRun ? 'Would unsend' : 'Unsent'} #${done} (other messages skipped: ${stats.skipped})`);
      if (!dryRun && breakEvery > 0 && done % breakEvery === 0) {
        log(`Pausing ${breakSeconds}s to stay under Instagram's rate limits...`);
        await sleep(breakSeconds * 1000);
      } else {
        await sleep(jitter(minDelay, maxDelay));
      }
    }
  }

  return stats;
}

// Writes the roles and aria-labels near the thread (no message text) so the
// selectors can be fixed if Instagram changes its markup.
async function inspect(page) {
  await page.waitForTimeout(3000);
  const last = page.locator(ROW).last();
  if (await last.count()) {
    const box = await last.boundingBox();
    if (box) await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.waitForTimeout(800);
  }
  const report = await page.evaluate(() => ({
    url: location.href,
    rows: document.querySelectorAll('[role="row"]').length,
    grids: [...document.querySelectorAll('[role="grid"]')].map((g) => g.getAttribute('aria-label')),
    labelled: [...document.querySelectorAll('[aria-label], [role="button"], [role="menuitem"]')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label') }))
      .filter((el) => el.label),
  }));
  await mkdir(path.join(ROOT, 'debug'), { recursive: true });
  const file = path.join(ROOT, 'debug', `inspect-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Found ${report.rows} message rows. Report saved to ${file}`);
}

async function launch(headless) {
  const userDataDir = path.join(ROOT, '.browser-profile');
  const base = { headless, viewport: null, args: ['--start-maximized'] };
  if (process.env.PW_CHROMIUM_PATH) {
    return chromium.launchPersistentContext(userDataDir, { ...base, executablePath: process.env.PW_CHROMIUM_PATH });
  }
  try {
    return await chromium.launchPersistentContext(userDataDir, { ...base, channel: 'chrome' });
  } catch {
    return chromium.launchPersistentContext(userDataDir, base);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      inspect: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      limit: { type: 'string' },
      'min-delay': { type: 'string', default: '1500' },
      'max-delay': { type: 'string', default: '4000' },
      'break-every': { type: 'string', default: '40' },
      'break-seconds': { type: 'string', default: '90' },
    },
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const context = await launch(values.headless);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    let threadUrl = positionals[0];
    await page.goto(threadUrl ?? INBOX_URL);

    if (page.url().includes('/accounts/login')) {
      await rl.question('Log in to Instagram in the browser window, then press Enter here... ');
      if (threadUrl) await page.goto(threadUrl);
    }
    if (!threadUrl) {
      await rl.question('Open the conversation in the browser window, then press Enter here... ');
      threadUrl = page.url();
    }
    if (threadUrl.includes('instagram.com') && !threadUrl.includes('/direct/t/')) {
      throw new Error(`Not a conversation URL: ${threadUrl}`);
    }

    if (values.inspect) return await inspect(page);

    const dryRun = values['dry-run'];
    if (!dryRun && !values.yes) {
      const answer = await rl.question(
        `This will UNSEND your messages for everyone in:\n  ${threadUrl}\nIt cannot be undone. Type YES to continue: `,
      );
      if (answer.trim() !== 'YES') return console.log('Cancelled.');
    }

    process.once('SIGINT', () => {
      console.log('\nStopped. Run the same command again to continue.');
      process.exit(130);
    });
    const stats = await unsendThread(page, {
      dryRun,
      limit: values.limit ? Number(values.limit) : Infinity,
      minDelay: Number(values['min-delay']),
      maxDelay: Number(values['max-delay']),
      breakEvery: Number(values['break-every']),
      breakSeconds: Number(values['break-seconds']),
    });
    console.log(
      dryRun
        ? `Dry run done. Your messages found: ${stats.found}. Other messages skipped: ${stats.skipped}.`
        : `Done. Unsent: ${stats.unsent}. Unconfirmed: ${stats.unconfirmed}. Other messages skipped: ${stats.skipped}.`,
    );
    console.log(`Stopped because: ${stats.stoppedBy}`);
  } finally {
    rl.close();
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
