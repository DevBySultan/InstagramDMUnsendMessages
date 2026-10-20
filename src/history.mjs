// The Chronicle: a record of past runs, saved in history.json next to the
// tool. It keeps counts and outcomes only, never message text.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 500;

export class History {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    this.entries = [];
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(saved)) this.entries = saved.filter((e) => e && typeof e.at === 'string');
    } catch {
      // No history yet, or an unreadable file: start empty.
    }
    return this;
  }

  // entry: { name, url, test, unsent, found, reverted, durationMs, outcome }
  async add(entry) {
    this.entries = [{ at: new Date().toISOString(), ...entry }, ...this.entries].slice(0, MAX_ENTRIES);
    await writeFile(this.file, JSON.stringify(this.entries, null, 2));
  }

  async clear() {
    this.entries = [];
    await writeFile(this.file, '[]');
  }

  // All-time figures for real runs (test runs delete nothing).
  get totals() {
    const real = this.entries.filter((e) => !e.test);
    return {
      runs: real.length,
      unsent: real.reduce((sum, e) => sum + (e.unsent || 0), 0),
      timeMs: real.reduce((sum, e) => sum + (e.durationMs || 0), 0),
      conversations: new Set(real.filter((e) => e.unsent > 0).map((e) => e.url)).size,
      since: this.entries.at(-1)?.at ?? null,
    };
  }
}
