// Unsends your own messages in one Instagram DM conversation by driving the
// regular instagram.com web UI in a browser window on your own computer.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INBOX_URL = 'https://www.instagram.com/direct/inbox/';

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

// Sleeps in short steps so a stop request is noticed quickly.
async function wait(ms, shouldStop) {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) await sleep(Math.min(250, end - Date.now()));
}

// Runs in the page. Instagram's markup has no roles for messages, so this finds
// the list under data-pagelet="IGDMessagesList", tags each message row, and
// marks rows that are right-aligned (sent by you). Each row also gets a
// fingerprint of its content, to recognize a message Instagram puts back.
// Returns the row count, or null when the conversation is not on screen.
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
    const media = [...row.querySelectorAll('img, video, audio')].map((m) => m.tagName + (m.getAttribute('alt') ?? ''));
    row.setAttribute('data-unsend-fp', `${row.textContent.trim()}|${media.join(',')}`);
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

// Where a message sits, to recognize it if Instagram puts it back: the
// nearest row above it that is not yours (we never remove those) and has
// content, like the other person's message or a date line. A message that
// comes back returns below that row, while older messages load above it, so
// a repeated text like "ok" from older history is not counted. Rows without
// content (the loading spinner at the top) do not count: older messages load
// below those. Returns the anchor's id, or 'top' when no such row is loaded.
const anchorOf = (handle) => handle.evaluate((el) => {
  const usable = (row) => row.getAttribute('data-unsend-mine') === '0' && row.getAttribute('data-unsend-fp') !== '|';
  let ref = el.previousElementSibling;
  while (ref && !usable(ref)) ref = ref.previousElementSibling;
  if (!ref) return 'top';
  if (!ref.hasAttribute('data-unsend-anchor')) ref.setAttribute('data-unsend-anchor', Math.random().toString(36).slice(2));
  return ref.getAttribute('data-unsend-anchor');
});

// For each [anchor, fingerprint], how many of your messages with that
// fingerprint are below the anchor; null when the anchor is gone.
const countBelow = (page, groups) => page.evaluate((pairs) => pairs.map(([anchor, fp]) => {
  let row;
  if (anchor === 'top') row = document.querySelector('[data-unsend-row]');
  else {
    const ref = document.querySelector(`[data-unsend-anchor="${anchor}"]`);
    if (!ref) return null;
    row = ref.nextElementSibling;
  }
  let count = 0;
  for (; row; row = row.nextElementSibling) {
    if (row.getAttribute('data-unsend-mine') === '1' && row.getAttribute('data-unsend-fp') === fp) count++;
  }
  return count;
}), groups);

// Returns 'skipped' (no Unsend in the menu), 'found' (dry run), 'unsent',
// 'unconfirmed' (the message stayed on screen), or 'reverted' (it went away
// and Instagram put it back, meaning its server refused the unsend).
// Text of popups and notices Instagram shows (errors, "try again later").
const readNotices = (page) => page.evaluate(() => {
  const nodes = document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], [role="dialog"]');
  return [...nodes].map((el) => el.innerText?.trim().replace(/\s+/g, ' ')).filter((text) => text && text.length < 300);
}).catch(() => []);

async function processRow(page, handle, { dryRun, settleMs, notices }) {
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

    const group = [await anchorOf(handle), await handle.getAttribute('data-unsend-fp')];
    const [before] = await countBelow(page, [group]);
    const shape = await handle.evaluate((el) => [el.textContent, el.querySelectorAll('img, video, audio').length]);
    await unsendItem.click();
    const confirm = await firstVisible(page.getByRole('dialog').getByRole('button', { name: LABELS.unsend }), 3000);
    if (confirm) await confirm.click();

    try {
      await page.waitForFunction(
        ([el, [text, media]]) => !el.isConnected || el.textContent !== text || el.querySelectorAll('img, video, audio').length !== media,
        [handle, shape],
        { timeout: 6000 },
      );
    } catch {
      return 'unconfirmed';
    }
    // Instagram hides the message at once and puts it back if its server
    // refuses, so check again after a moment.
    // Notices can disappear quickly, so read them while waiting.
    const end = Date.now() + settleMs;
    while (Date.now() < end) {
      for (const text of await readNotices(page)) if (!LABELS.unsend.test(text)) notices.add(text);
      await sleep(250);
    }
    await page.evaluate(tagRows);
    const [after] = await countBelow(page, [group]);
    return after !== null && after >= before ? 'reverted' : 'unsent';
  } finally {
    await handle.evaluate((el, [current, seen]) => {
      el.removeAttribute(current);
      el.setAttribute(seen, '1');
    }, [CURRENT, SEEN]).catch(() => {});
  }
}

// Scrolls to the oldest loaded message so Instagram loads older ones.
// Returns true when new messages showed up. Without needGrowth, any of your
// messages not yet processed also counts.
async function loadOlder(page, { attempts = 4, needGrowth = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    const before = await page.evaluate(tagRows);
    // Instagram loads older messages when the top comes into view, so if the
    // list is already at the top, move away a little first.
    await page.evaluate(async () => {
      const scroller = document.querySelector('[data-unsend-scroller]');
      if (!scroller) return;
      const reversed = getComputedStyle(scroller).flexDirection === 'column-reverse';
      const top = reversed ? -(scroller.scrollHeight - scroller.clientHeight) : 0;
      if (Math.abs(scroller.scrollTop - top) < 50) {
        scroller.scrollTop = top + 600;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      scroller.scrollTop = top;
    });
    const box = await page.locator('[data-unsend-scroller]').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.wheel(0, -3000);
    }
    await sleep(1500 + i * 1500);
    const after = await page.evaluate(tagRows);
    if (after > before || (!needGrowth && (await page.locator(`${ROW}${MINE}:not([${SEEN}])`).count()) > 0)) return true;
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

// Why a run ended: 'end' (start of the conversation reached), 'limit',
// 'stopped' (shouldStop returned true), 'blocked' (Instagram's "try again
// later"), 'unconfirmed' (5 unsends in a row left the message on screen),
// 'refused' (Instagram put back the first message of the run: the
// conversation or the account does not take unsends from the web right now),
// or 'limited' (messages came back after others worked: a rate limit).
// onEvent receives { type: 'unsent' | 'found' | 'loading' | 'pause' | 'working' | 'reverted' | 'checking', ... }.
export async function unsendThread(page, options = {}) {
  const {
    dryRun = false,
    limit = Infinity,
    minDelay = 1500,
    maxDelay = 4000,
    breakEvery = 40,
    breakSeconds = 90,
    settleMs = 1500,
    // How long to wait at the end before the last check for put-back messages.
    finalCheckMs = 5000,
    revertBackoff = 20000,
    shouldStop = () => false,
    onEvent = () => {},
  } = options;
  // notices: what Instagram said when it put messages back, to show the user.
  const stats = { unsent: 0, found: 0, skipped: 0, unconfirmed: 0, reverted: 0, notices: [], stoppedBy: 'end' };
  let failuresInARow = 0;
  let revertsInARow = 0;
  // Breaks come at an uneven count and last an uneven time, like a person's.
  const nextBreakAfter = () => (breakEvery > 0 ? Math.round(jitter(breakEvery * 0.75, breakEvery * 1.25)) : Infinity);
  let untilBreak = nextBreakAfter();
  // Fingerprint -> times Instagram put that message back. A put-back message
  // is a new element, so without this it would be picked again forever.
  const revertedTimes = new Map();
  // "anchor|fingerprint" -> { group, expected }: how many such messages were
  // below the anchor after unsending one, to catch a message Instagram puts
  // back later than settleMs.
  const unsentGroups = new Map();
  // Moves messages that came back late from unsent to reverted. Returns how many.
  const verifyUnsent = async () => {
    if (dryRun || unsentGroups.size === 0) return 0;
    await page.evaluate(tagRows);
    const entries = [...unsentGroups.entries()];
    const counts = await countBelow(page, entries.map(([, { group }]) => group));
    let back = 0;
    entries.forEach(([key, { group, expected }], i) => {
      if (counts[i] === null || counts[i] <= expected) return;
      back += counts[i] - expected;
      unsentGroups.set(key, { group, expected: counts[i] });
      revertedTimes.set(group[1], (revertedTimes.get(group[1]) ?? 0) + 1);
    });
    stats.unsent -= back;
    stats.reverted += back;
    return back;
  };
  // Once the start of the conversation is loaded, nothing older can appear.
  let reachedStart = false;
  const stopForLateRevert = () => {
    stats.stoppedBy = stats.unsent === 0 ? 'refused' : 'limited';
    onEvent({ type: 'reverted', inARow: 1, count: stats.unsent });
  };

  if (!(await waitForMessages(page))) throw new Error('Could not find the conversation messages on the page.');

  while (true) {
    if (shouldStop()) {
      stats.stoppedBy = 'stopped';
      break;
    }
    if (stats.unsent + stats.found >= limit) {
      stats.stoppedBy = 'limit';
      break;
    }
    await page.evaluate(tagRows);
    const next = page.locator(`${ROW}${MINE}:not([${SEEN}])`).last();
    if ((await next.count()) === 0) {
      onEvent({ type: 'loading' });
      const rowsBefore = await page.evaluate(tagRows);
      if (!(await loadOlder(page))) break;
      // Older messages after all: positions counted from the top no longer hold.
      if ((await page.evaluate(tagRows)) > rowsBefore && reachedStart) {
        reachedStart = false;
        for (const [key, { group }] of unsentGroups) if (group[0] === 'top') unsentGroups.delete(key);
      }
      continue;
    }

    const handle = await next.elementHandle();
    const fp = await handle.getAttribute('data-unsend-fp');
    let anchor = await anchorOf(handle);
    // With no message from the other person above it, older messages loading
    // later could be mistaken for put-back ones. Load until there is one, or
    // until the start of the conversation.
    if (anchor === 'top' && !reachedStart && !dryRun) {
      onEvent({ type: 'loading' });
      if (await loadOlder(page, { needGrowth: true })) continue;
      reachedStart = true;
      anchor = await anchorOf(handle);
    }
    // A row we already unsent showing up again below its anchor came back late.
    if (unsentGroups.has(`${anchor}|${fp}`) && (await verifyUnsent()) > 0) {
      stopForLateRevert();
      break;
    }
    if ((revertedTimes.get(fp) ?? 0) >= 2) {
      await handle.evaluate((el, seen) => el.setAttribute(seen, '1'), SEEN);
      continue;
    }

    onEvent({ type: 'working' });
    const notices = new Set();
    const result = await processRow(page, handle, { dryRun, settleMs, notices });
    stats[result]++;

    if (await isBlocked(page)) {
      stats.stoppedBy = 'blocked';
      break;
    }

    if (result === 'unconfirmed') {
      if (++failuresInARow >= 5) {
        stats.stoppedBy = 'unconfirmed';
        break;
      }
    } else if (result === 'reverted') {
      revertedTimes.set(fp, (revertedTimes.get(fp) ?? 0) + 1);
      for (const text of notices) if (!stats.notices.includes(text)) stats.notices.push(text);
      onEvent({ type: 'reverted', inARow: ++revertsInARow });
      // Retrying would only add attempts Instagram counts against the account.
      if (stats.unsent === 0) {
        stats.stoppedBy = 'refused';
        break;
      }
      if (revertsInARow >= 2) {
        stats.stoppedBy = 'limited';
        break;
      }
      const seconds = (revertBackoff / 1000) * revertsInARow;
      onEvent({ type: 'pause', seconds, reason: 'reverted' });
      await wait(seconds * 1000, shouldStop);
    } else if (result === 'unsent') {
      failuresInARow = 0;
      revertsInARow = 0;
      const group = [anchor, fp];
      const [expected] = await countBelow(page, [group]);
      if (expected !== null) unsentGroups.set(`${anchor}|${fp}`, { group, expected });
    }

    if (result === 'unsent' || result === 'found') {
      const done = stats.unsent + stats.found;
      onEvent({ type: result, count: done });
      if (!dryRun && --untilBreak <= 0) {
        const seconds = Math.round(breakSeconds * jitter(0.8, 1.3));
        onEvent({ type: 'pause', seconds });
        await wait(seconds * 1000, shouldStop);
        untilBreak = nextBreakAfter();
        if ((await verifyUnsent()) > 0) {
          stopForLateRevert();
          break;
        }
      } else {
        await wait(jitter(minDelay, maxDelay), shouldStop);
      }
    }
  }

  // A last look, so the record never counts a message Instagram put back.
  if (!dryRun && unsentGroups.size > 0) {
    onEvent({ type: 'checking' });
    await sleep(finalCheckMs);
    if ((await verifyUnsent()) > 0 && ['end', 'limit', 'stopped'].includes(stats.stoppedBy)) stopForLateRevert();
  }
  return stats;
}

// Writes the structure and labels of the page (no message text) so the
// selectors can be fixed if Instagram changes its markup.
export async function inspect(page, dir) {
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
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `inspect-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  return { file, rows: report.rows, yourRows: report.yourRows };
}

export const isLoginPage = (page) => /\/accounts\/login|\/challenge\//.test(page.url());

// The language Instagram is shown in, from <html lang>.
export const pageLanguage = (page) => page.evaluate(() => document.documentElement.lang || '');
