// Settings and recent conversations, saved in settings.json next to the tool.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SPEEDS = {
  safe: {
    name: 'Safe',
    summary: '3-7 s between messages, 2 min break every 30',
    minDelay: 3000, maxDelay: 7000, breakEvery: 30, breakSeconds: 120,
  },
  normal: {
    name: 'Normal',
    summary: '1.5-4 s between messages, 90 s break every 40',
    minDelay: 1500, maxDelay: 4000, breakEvery: 40, breakSeconds: 90,
  },
  fast: {
    name: 'Fast',
    summary: '0.8-2 s between messages, 1 min break every 60 (higher risk of a block)',
    minDelay: 800, maxDelay: 2000, breakEvery: 60, breakSeconds: 60,
  },
};

// dailyLimit is a guard of our own: Instagram does not publish its limits.
const DEFAULTS = {
  speed: 'safe',
  limit: 0,
  dailyLimit: 300,
  today: { date: '', count: 0 },
  lastLimitedAt: null,
  lastRunAt: null,
  recent: [],
};
const MAX_RECENT = 8;

const localDate = () => new Date().toLocaleDateString('en-CA');

export class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    Object.assign(this, structuredClone(DEFAULTS));
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.speed in SPEEDS) this.speed = saved.speed;
      if (Number.isInteger(saved.limit) && saved.limit >= 0) this.limit = saved.limit;
      if (Number.isInteger(saved.dailyLimit) && saved.dailyLimit >= 0) this.dailyLimit = saved.dailyLimit;
      if (saved.today && typeof saved.today.date === 'string') this.today = { date: saved.today.date, count: Number(saved.today.count) || 0 };
      if (typeof saved.lastLimitedAt === 'string') this.lastLimitedAt = saved.lastLimitedAt;
      if (typeof saved.lastRunAt === 'string') this.lastRunAt = saved.lastRunAt;
      if (Array.isArray(saved.recent)) this.recent = saved.recent.filter((r) => r && typeof r.url === 'string');
    } catch {
      // No settings yet, or an unreadable file: keep the defaults.
    }
    return this;
  }

  async save() {
    const { speed, limit, dailyLimit, today, lastLimitedAt, lastRunAt, recent } = this;
    await writeFile(this.file, JSON.stringify({ speed, limit, dailyLimit, today, lastLimitedAt, lastRunAt, recent }, null, 2));
  }

  get speedProfile() {
    return SPEEDS[this.speed];
  }

  // Messages unsent today, in local time.
  get unsentToday() {
    return this.today.date === localDate() ? this.today.count : 0;
  }

  // Moves the conversation to the top of the recent list and adds to its totals.
  async remember(url, { name, unsent = 0, tested = false } = {}) {
    const existing = this.recent.find((r) => r.url === url);
    const entry = existing ?? { url, name: '', unsent: 0 };
    if (name) entry.name = name;
    if (tested) entry.tested = true;
    entry.unsent += unsent;
    this.today = { date: localDate(), count: this.unsentToday + unsent };
    entry.lastUsed = new Date().toISOString();
    this.recent = [entry, ...this.recent.filter((r) => r !== entry)].slice(0, MAX_RECENT);
    await this.save();
  }

  async forget(url) {
    this.recent = this.recent.filter((r) => r.url !== url);
    await this.save();
  }
}
