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
  more: /^(See more options.*|More options.*|More|المزيد.*|خيارات.*)$/i,
  unsend: /^(Unsend|إلغاء الإرسال)$/i,
  blocked: /(try again later|action blocked|we restrict certain activity|حاول مرة أخرى لاحق|تم حظر)/i,
};

// Attributes the bot puts on Instagram's elements to keep track of them.
const ROW = '[data-unsend-row]';
const MINE = '[data-unsend-mine="1"]';
const SEEN = 'data-unsend-seen';
const CURRENT = 'data-unsend-current';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

// Runs in the page. Instagram's markup has no roles for messages, so this finds
// the list under data-pagelet="IGDMessagesList", tags each message row, and
// marks rows that are right-aligned (sent by you). Returns the row count, or
// null when the conversation is not on screen.
function tagRows() {
  const list = document.querySelector('[data-pagelet="IGDMessagesList"]')
    ?? document.querySelector('[data-pagelet*="MessagesList"]');
  if (!list) return null;

  const scrollables = [...list.querySelectorAll('div')].filter((el) => {
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll';
  });
  const scroller = scrollables.find((el) => el.scrollHeight > el.clientHeight) ?? scrollables[0] ?? list;
  scroller.setAttribute('data-unsend-scroller', '1');

  // The rows are the children of the descendant with the most children.
  let inner = scroller;
  const search = (el, depth) => {
    if (depth > 3) return;
    for (const child of el.children) {
      if (child.children.length > inner.children.length) inner = child;
      search(child, depth + 1);
    }
  };
  search(scroller, 0);

  const isMine = (row) => {
    const queue = [[row, 0]];
    while (queue.length) {
      const [el, depth] = queue.shift();
      if (getComputedStyle(el).justifyContent === 'flex-end') return true;
      if (depth < 8) for (const child of el.children) queue.push([child, depth + 1]);
    }
    return false;
  };
  for (const row of inner.children) {
    row.setAttribute('data-unsend-row', '1');
    if (!row.hasAttribute('data-unsend-mine')) row.setAttribute('data-unsend-mine', isMine(row) ? '1' : '0');
  }
  return inner.children.length;
}

async function firstVisible(locator, timeout) {
  const target = locator.filter({ visible: true }).first();
  try {
    await target.waitFor({ state: 'visible', timeout });
    return target;
  } catch {
    return null;
  }
}

// Hovers the message so Instagram shows its "See more options" button. The
// button is inside the row, or rendered next to it at the same height.
// Older messages can load above the row and push it off screen, so it is
// scrolled back into view before every attempt.
async function revealMoreButton(page, row) {
  for (const xRatio of [null, 0.85, 0.6]) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const box = await row.boundingBox();
    if (!box) return null;
    const bubble = xRatio === null
      ? await row.locator('[role="none"], [role="presentation"]').last().boundingBox({ timeout: 500 }).catch(() => null)
      : null;
    const [x, y] = bubble
      ? [bubble.x + bubble.width / 2, bubble.y + bubble.height / 2]
      : [box.x + box.width * (xRatio ?? 0.85), box.y + box.height / 2];
    await page.mouse.move(x, y, { steps: 3 });

    const inRow = await firstVisible(
      row.getByLabel(LABELS.more).or(row.locator('[role="button"][aria-haspopup="menu"]')),
      700,
    );
    if (inRow) return inRow;

    for (const candidate of await page.getByLabel(LABELS.more).filter({ visible: true }).all()) {
      const b = await candidate.boundingBox();
      if (!b) continue;
      const centerX = b.x + b.width / 2;
      const centerY = b.y + b.height / 2;
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

// Returns 'skipped' (no Unsend in the menu), 'found' (dry run), 'unsent', or
// 'unconfirmed' (the flow completed but the message stayed on screen).
async function processRow(page, handle, dryRun) {
  await handle.evaluate((el, attr) => el.setAttribute(attr, '1'), CURRENT);
  const row = page.locator(`[${CURRENT}]`);
  try {
    const more = await revealMoreButton(page, row);
    if (!more) return 'skipped';

    await more.click();
    // Once the menu is open, a missing "Unsend" means it cannot be unsent.
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

    const content = '[role="none"], [role="presentation"]';
    const hadContent = await handle.evaluate((el, selector) => !!el.querySelector(selector), content);
    await unsendItem.click();
    const confirm = await firstVisible(page.getByRole('dialog').getByRole('button', { name: LABELS.unsend }), 3000);
    if (confirm) await confirm.click();

    try {
      await page.waitForFunction(
        ([el, selector, had]) => !el.isConnected || el.textContent.trim() === '' || (had && !el.querySelector(selector)),
        [handle, content, hadContent],
        { timeout: 6000 },
      );
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
// Returns true when new messages showed up.
async function loadOlder(page, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const before = await page.evaluate(tagRows);
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-unsend-scroller]');
      if (!scroller) return;
      const reversed = getComputedStyle(scroller).flexDirection === 'column-reverse';
      scroller.scrollTop = reversed ? -(scroller.scrollHeight - scroller.clientHeight) : 0;
    });
    const box = await page.locator('[data-unsend-scroller]').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.wheel(0, -3000);
    }
    await sleep(1500 + i * 1500);
    const after = await page.evaluate(tagRows);
    if (after > before || (await page.locator(`${ROW}${MINE}:not([${SEEN}])`).count()) > 0) return true;
  }
  return false;
}

// Waits until the conversation's messages are on screen.
export async function waitForMessages(page, timeout = 30000) {
  try {
    await page.waitForFunction(tagRows, null, { timeout, polling: 1000 });
    return true;
  } catch {
    return false;
  }
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

  if (!(await waitForMessages(page))) throw new Error('Could not find the conversation messages on the page.');

  while (true) {
    if (stats.unsent + stats.found >= limit) {
      stats.stoppedBy = `reached --limit ${limit}`;
      break;
    }
    await page.evaluate(tagRows);
    const next = page.locator(`${ROW}${MINE}:not([${SEEN}])`).last();
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
      log(`${dryRun ? 'Would unsend' : 'Unsent'} #${done}`);
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

// Writes the structure and labels of the page (no message text) so the
// selectors can be fixed if Instagram changes its markup.
async function inspect(page) {
  const rows = await page.evaluate(tagRows);
  const last = page.locator(`${ROW}${MINE}`).last();
  if (await last.count()) {
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    if (box) await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.waitForTimeout(800);
  }
  const report = await page.evaluate(() => ({
    url: location.href,
    pagelets: [...document.querySelectorAll('[data-pagelet]')].map((el) => el.getAttribute('data-pagelet')),
    rows: document.querySelectorAll('[data-unsend-row]').length,
    yourRows: document.querySelectorAll('[data-unsend-mine="1"]').length,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((el) => el.getAttribute('aria-label')),
    labelled: [...document.querySelectorAll('[aria-label], [role="button"], [role="menuitem"]')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label') }))
      .filter((el) => el.label),
  }));
  report.rows = rows ?? 0;
  await mkdir(path.join(ROOT, 'debug'), { recursive: true });
  const file = path.join(ROOT, 'debug', `inspect-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Found ${report.rows} messages, ${report.yourRows} of them yours. Report saved to ${file}`);
  return file;
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

    // Instagram can show popups after logging in (save login info, PIN, notifications).
    while (!(await waitForMessages(page))) {
      const file = await inspect(page);
      await rl.question(
        'Could not find the messages of the conversation.\n'
        + '  - Close any Instagram popup in the window and make sure the conversation is open.\n'
        + `  - If this keeps happening, send the file ${file}\n`
        + 'Press Enter to try again, or Ctrl+C to quit... ',
      );
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
        ? `Dry run done. Your messages found: ${stats.found}.`
        : `Done. Unsent: ${stats.unsent}. Unconfirmed: ${stats.unconfirmed}.`,
    );
    if (stats.skipped) console.log(`Messages that looked like yours but had no Unsend option: ${stats.skipped}.`);
    console.log(`Stopped because: ${stats.stoppedBy}`);
    if (stats.unsent + stats.found === 0) {
      console.log(`Nothing found. Send the file ${await inspect(page)}`);
    }
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
