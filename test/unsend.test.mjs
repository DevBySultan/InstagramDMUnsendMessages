import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unsendThread, waitForMessages } from '../unsend.mjs';

const MOCK = pathToFileURL(new URL('./mock-thread.html', import.meta.url).pathname).href;
const FAST = { minDelay: 0, maxDelay: 0, breakEvery: 0, log: () => {} };
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
