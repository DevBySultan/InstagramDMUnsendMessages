import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Settings } from '../src/settings.mjs';

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ig-unsend-settings-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('counts unsends per day and starts over on a new day', () => withDir(async (dir) => {
  const settings = await new Settings(dir).load();
  await settings.remember('https://www.instagram.com/direct/t/1/', { unsent: 7 });
  await settings.remember('https://www.instagram.com/direct/t/2/', { unsent: 5 });
  assert.equal(settings.unsentToday, 12);

  const reloaded = await new Settings(dir).load();
  assert.equal(reloaded.unsentToday, 12);

  reloaded.today.date = '2000-01-01';
  assert.equal(reloaded.unsentToday, 0);
  await reloaded.remember('https://www.instagram.com/direct/t/1/', { unsent: 3 });
  assert.equal(reloaded.unsentToday, 3);
}));

test('remembers that a conversation was tested and keeps its totals', () => withDir(async (dir) => {
  const settings = await new Settings(dir).load();
  const url = 'https://www.instagram.com/direct/t/1/';
  await settings.remember(url, { name: 'Old friend', tested: true });
  await settings.remember(url, { unsent: 4 });
  const [entry] = (await new Settings(dir).load()).recent;
  assert.equal(entry.name, 'Old friend');
  assert.equal(entry.tested, true);
  assert.equal(entry.unsent, 4);
}));

test('ignores invalid saved values', () => withDir(async (dir) => {
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ speed: 'warp', dailyLimit: -5, lastLimitedAt: 42 }));
  const settings = await new Settings(dir).load();
  assert.equal(settings.speed, 'safe');
  assert.equal(settings.dailyLimit, 300);
  assert.equal(settings.lastLimitedAt, null);
}));

test('renames and removes saved conversations, some or all', () => withDir(async (dir) => {
  const settings = await new Settings(dir).load();
  for (const id of [1, 2, 3]) await settings.remember(`https://www.instagram.com/direct/t/${id}/`, { name: `Chat ${id}` });
  await settings.rename('https://www.instagram.com/direct/t/2/', 'Renamed');
  await settings.forget(['https://www.instagram.com/direct/t/1/', 'https://www.instagram.com/direct/t/3/']);
  let reloaded = await new Settings(dir).load();
  assert.deepEqual(reloaded.recent.map((r) => r.name), ['Renamed']);
  await reloaded.forget();
  reloaded = await new Settings(dir).load();
  assert.equal(reloaded.recent.length, 0);
}));

test('keeps the last outcome of a conversation and resets to defaults', () => withDir(async (dir) => {
  const settings = await new Settings(dir).load();
  settings.dailyLimit = 50;
  await settings.remember('https://www.instagram.com/direct/t/1/', { status: 'refused' });
  assert.equal((await new Settings(dir).load()).recent[0].status, 'refused');
  settings.reset();
  assert.equal(settings.dailyLimit, 300);
  assert.equal(settings.recent.length, 0);
}));
