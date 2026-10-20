import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History } from '../src/history.mjs';

test('records runs newest first and totals real runs only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ig-unsend-history-'));
  try {
    const history = await new History(dir).load();
    await history.add({ name: 'A', url: 'u1', test: true, found: 5, durationMs: 1000, outcome: 'limit' });
    await history.add({ name: 'A', url: 'u1', unsent: 40, durationMs: 60000, outcome: 'stopped' });
    await history.add({ name: 'B', url: 'u2', unsent: 0, durationMs: 2000, outcome: 'refused' });
    await history.add({ name: 'A', url: 'u1', unsent: 60, durationMs: 90000, outcome: 'end' });

    const reloaded = await new History(dir).load();
    assert.deepEqual(reloaded.entries.map((e) => e.outcome), ['end', 'refused', 'stopped', 'limit']);
    assert.deepEqual(
      { runs: reloaded.totals.runs, unsent: reloaded.totals.unsent, conversations: reloaded.totals.conversations, timeMs: reloaded.totals.timeMs },
      { runs: 3, unsent: 100, conversations: 1, timeMs: 152000 },
    );
    assert.equal(reloaded.totals.since, reloaded.entries.at(-1).at);

    await reloaded.clear();
    assert.equal((await new History(dir).load()).entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
