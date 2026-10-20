import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unsendThread, waitForMessages } from '../src/unsender.mjs';

const MOCK = pathToFileURL(new URL('./mock-thread.html', import.meta.url).pathname).href;
const FAST = { minDelay: 0, maxDelay: 0, breakEvery: 0, settleMs: 700, finalCheckMs: 1000, revertBackoff: 0 };
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
});
after(() => browser?.close());

async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(MOCK + query);
  return page;
}

const remaining = (page) => page.$$eval('.row', (rows) => rows.map((r) => !!r.querySelector('.mine')));

test('unsends every own message across older pages and keeps the other side', async () => {
  const page = await open();
  const stats = await unsendThread(page, FAST);
  assert.equal(stats.unsent, 60);
  assert.equal(stats.unconfirmed, 0);
  const rows = await remaining(page);
  assert.equal(rows.length, 30);
  assert.ok(rows.every((mine) => !mine));
  await page.close();
});

test('finds the More button when the toolbar is rendered outside the row', async () => {
  const page = await open('?portal=1');
  const stats = await unsendThread(page, { ...FAST, limit: 10 });
  assert.equal(stats.unsent, 10);
  assert.match(stats.stoppedBy, /limit/);
  await page.close();
});

test('dry run unsends nothing', async () => {
  const page = await open();
  const stats = await unsendThread(page, { ...FAST, dryRun: true });
  assert.equal(stats.found, 60);
  assert.equal(await page.evaluate(() => window.state.unsent()), 0);
  await page.close();
});

test('stops when Instagram blocks the action', async () => {
  const page = await open('?blockAfter=3');
  const stats = await unsendThread(page, FAST);
  assert.equal(stats.unsent, 3);
  assert.match(stats.stoppedBy, /blocked/);
  await page.close();
});

test('reports when the conversation is not on the page', async () => {
  const page = await browser.newPage();
  await page.setContent('<p>Save your login info?</p>');
  assert.equal(await waitForMessages(page, 1500), false);
  await page.close();
});

test('stops safely when asked to', async () => {
  const page = await open();
  let events = 0;
  const stats = await unsendThread(page, { ...FAST, onEvent: (e) => { if (e.type === 'unsent') events++; }, shouldStop: () => events >= 2 });
  assert.equal(stats.unsent, 2);
  assert.equal(stats.stoppedBy, 'stopped');
  await page.close();
});

test('stops at the first message when the conversation refuses unsends', async () => {
  const page = await open('?revertAfter=0');
  const stats = await unsendThread(page, { ...FAST, settleMs: 1500 });
  assert.equal(stats.unsent, 0);
  assert.equal(stats.reverted, 1);
  assert.equal(stats.stoppedBy, 'refused');
  assert.deepEqual(stats.notices, ["Couldn't unsend message"]);
  assert.equal((await remaining(page)).filter(Boolean).length, 20);
  await page.close();
});

test('treats messages put back after others worked as a rate limit', async () => {
  const page = await open('?revertAfter=4');
  const stats = await unsendThread(page, { ...FAST, settleMs: 1500 });
  assert.equal(stats.unsent, 4);
  assert.equal(stats.reverted, 2);
  assert.equal(stats.stoppedBy, 'limited');
  await page.close();
});

test('corrects the count when Instagram puts a message back late', async () => {
  // Put back 2.5 s after hiding, long after the 0.7 s the bot waits.
  const page = await open('?revertAfter=2&revertDelay=2500');
  const stats = await unsendThread(page, { ...FAST, finalCheckMs: 3500 });
  assert.equal(await page.evaluate(() => window.state.unsent()), 2);
  assert.equal(stats.unsent, 2);
  assert.ok(stats.reverted >= 1);
  assert.equal(stats.stoppedBy, 'limited');
  await page.close();
});

test('repeated texts loading from older messages are not mistaken for put-back ones', async () => {
  const page = await open('?dupes=1');
  const stats = await unsendThread(page, FAST);
  assert.equal(stats.reverted, 0);
  assert.equal(stats.unsent, 60);
  assert.equal(stats.stoppedBy, 'end');
  await page.close();
});

test('a chat of only your own identical messages is unsent without false put-backs', async () => {
  const page = await open('?dupes=1&allMine=1');
  const stats = await unsendThread(page, FAST);
  assert.equal(stats.reverted, 0);
  assert.equal(stats.unsent, 90);
  assert.equal(stats.stoppedBy, 'end');
  await page.close();
});

test('detects put-back messages in a chat of repeated texts', async () => {
  const page = await open('?dupes=1&revertAfter=3');
  const stats = await unsendThread(page, { ...FAST, settleMs: 1500 });
  assert.equal(stats.unsent, 3);
  assert.equal(stats.stoppedBy, 'limited');
  await page.close();
});

test('the browser starts as plain Chrome and does not announce itself as automated', async () => {
  const { launchBrowser } = await import('../src/browser.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/ig-unsend-profile-`);
  const session = await launchBrowser(dir, { headless: true });
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  await page.setContent('<p>x</p>');
  assert.equal(await page.evaluate(() => navigator.webdriver), false);
  let closed = false;
  session.onClose(() => { closed = true; });
  await session.close();
  assert.equal(closed, true);
  await rm(dir, { recursive: true, force: true });
});
