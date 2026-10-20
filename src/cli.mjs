// The interactive terminal app: menus, choosing a conversation, running and
// reporting. The browser automation lives in unsender.mjs.

import * as prompts from '@inquirer/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INBOX_URL, inspect, isLoginPage, pageLanguage, unsendThread, waitForMessages,
} from './unsender.mjs';
import { launchBrowser } from './browser.mjs';
import { Settings, SPEEDS } from './settings.mjs';
import * as ui from './ui.mjs';

const { gold, pale, bronze, ivory, sage, amber, bold } = ui;

// Every prompt uses the app's theme.
const themed = (prompt) => (config) => prompt({ ...config, theme: ui.theme });
const select = themed(prompts.select);
const input = themed(prompts.input);
const number = themed(prompts.number);
const confirm = themed(prompts.confirm);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.browser-profile');
const DEBUG = path.join(ROOT, 'debug');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const CONVERSATION_URL = /^https:\/\/(www\.)?instagram\.com\/direct\/t\/(\d+)\/?(\?.*)?$/;

const settings = new Settings(ROOT);
let browser = null;
let page = null;

// ---------- Browser ----------

async function getPage() {
  if (page && !page.isClosed()) return page;
  if (!browser) {
    ui.info('Opening the browser window...');
    browser = await launchBrowser(PROFILE, { headless: !!process.env.IG_UNSEND_HEADLESS });
    browser.onClose(() => {
      browser = null;
      page = null;
    });
  }
  const pages = browser.context.pages();
  page = pages.find((p) => p.url().includes('instagram.com')) ?? pages[0] ?? (await browser.context.newPage());
  return page;
}

async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
}

// Goes to url, asking the user to log in first if Instagram wants that.
async function goTo(url) {
  const current = await getPage();
  await current.goto(url);
  while (isLoginPage(current)) {
    ui.warn('You are not logged in to Instagram.');
    ui.note('Log in inside the browser window. Your password stays in the browser, not in this tool.');
    const next = await select({
      message: 'When you are logged in:',
      choices: [{ name: 'Continue', value: 'go' }, { name: 'Back to menu', value: 'back' }],
    });
    if (next === 'back') return null;
    await current.goto(url);
  }
  return current;
}

async function openConversation(url) {
  const current = await goTo(url);
  if (!current) return null;
  ui.info('Loading the conversation...');
  while (!(await waitForMessages(current))) {
    const { file } = await inspect(current, DEBUG);
    ui.fail('Could not find the messages of this conversation.');
    ui.note('Close any Instagram popup in the browser window (save login info, notifications, PIN).');
    ui.note(`If this keeps happening, send this file for troubleshooting: ${file}`);
    const next = await select({
      message: 'What now?',
      choices: [{ name: 'Try again', value: 'retry' }, { name: 'Back to menu', value: 'back' }],
    });
    if (next === 'back') return null;
  }
  const lang = await pageLanguage(current);
  if (lang && !lang.toLowerCase().startsWith('en')) {
    ui.warn(`Instagram is shown in "${lang}". The tool is built for English.`);
    ui.note('If it finds nothing, switch Instagram to English (language selector at the bottom of instagram.com).');
  }
  ui.ok('Conversation loaded.');
  return current;
}

// ---------- Choosing a conversation ----------

const threadId = (url) => url.match(CONVERSATION_URL)?.[2] ?? url;
const isConversationUrl = (url) => CONVERSATION_URL.test(url) || (!!process.env.IG_UNSEND_ALLOW_ANY_URL && url.length > 0);
const label = (entry) => entry.name || `Conversation ${threadId(entry.url)}`;

async function chooseConversation() {
  while (true) {
    const recent = settings.recent.map((entry) => ({
      name: label(entry),
      value: entry,
      description: `${entry.url}  ·  ${entry.unsent} unsent so far  ·  last used ${entry.lastUsed?.slice(0, 10) ?? '-'}`,
    }));
    const choice = await select({
      message: 'Which conversation?',
      pageSize: 12,
      choices: [
        ...recent,
        ...(recent.length ? [ui.divider()] : []),
        { name: 'Paste a conversation link', value: 'paste', description: 'Open the chat on instagram.com and copy the address bar' },
        { name: 'Pick it in the browser window', value: 'pick', description: 'Open your inbox in the browser and click the chat' },
        { name: 'Back', value: 'back' },
      ],
    });
    if (choice === 'back') return null;
    if (typeof choice === 'object') return choice;

    if (choice === 'paste') {
      const url = (await input({
        message: 'Conversation link:',
        validate: (value) => isConversationUrl(value.trim()) || 'Paste a link like https://www.instagram.com/direct/t/1234567890/',
      })).trim();
      const name = (await input({ message: 'Name it (optional, only saved on this computer):' })).trim();
      return { url, name };
    }

    const current = await goTo(INBOX_URL);
    if (!current) continue;
    await select({
      message: 'Open the conversation in the browser window, then choose Continue.',
      choices: [{ name: 'Continue', value: 'go' }],
    });
    const url = current.url();
    if (!isConversationUrl(url)) {
      ui.fail('The browser is not showing a conversation. Click a chat in the inbox first.');
      continue;
    }
    const name = (await input({ message: 'Name it (optional, only saved on this computer):' })).trim();
    return { url, name };
  }
}

// ---------- Actions ----------

const REASONS = {
  end: ['ok', 'Reached the start of the conversation.'],
  limit: ['ok', 'Reached the limit for this run.'],
  daily: ['ok', "Reached today's cap. Continue tomorrow, or raise the cap in Settings."],
  stopped: ['warn', 'You stopped it. Run it again to continue where it left off.'],
  refused: ['fail', 'Instagram put the first message back: it does not take unsends here right now. Nothing was unsent.'],
  limited: ['fail', 'Instagram started putting messages back after others worked: a rate limit. Wait 24 hours, then continue on Safe speed.'],
  blocked: ['fail', 'Instagram said "Try again later". Wait a few hours (a day is safer), then use the Safe speed.'],
  unconfirmed: ['fail', 'Messages stopped disappearing after Unsend. Run Diagnose and send the report.'],
};

const HOUR = 3600000;
const hoursSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / HOUR : Infinity);
const ago = (iso) => {
  const hours = hoursSince(iso);
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : `${Math.round(hours)} h ago`;
};

// What makes a first run go through. Returns how many messages this run may
// unsend, or 0 when it should not start.
async function preflight(current, target) {
  const lang = (await pageLanguage(current)).toLowerCase();
  const tested = settings.recent.find((r) => r.url === target.url)?.tested;
  const left = settings.dailyLimit ? Math.max(0, settings.dailyLimit - settings.unsentToday) : Infinity;
  const checks = [
    !lang || lang.startsWith('en')
      ? ['ok', 'Instagram is in English']
      : ['warn', `Instagram is in "${lang}": switch it to English (language selector at the bottom of instagram.com)`],
    settings.speed === 'safe'
      ? ['ok', 'Speed is Safe']
      : ['warn', `Speed is ${settings.speedProfile.name}: Safe is less likely to get limited`],
    hoursSince(settings.lastLimitedAt) >= 24
      ? ['ok', 'Instagram has not refused or limited unsends in the last 24 hours']
      : ['fail', `Instagram refused or limited unsends ${ago(settings.lastLimitedAt)}: trying again within 24 hours can extend it`],
    hoursSince(settings.lastRunAt) >= 1
      ? ['ok', 'At least an hour since the last run']
      : ['warn', `The last run was ${ago(settings.lastRunAt)}: leave an hour between runs`],
    tested ? ['ok', 'Test run done on this conversation'] : ['warn', 'No test run on this conversation yet'],
    ...(Number.isFinite(left)
      ? [left > 0 ? ['ok', `${left} of today's ${settings.dailyLimit} left`] : ['fail', `Today's cap of ${settings.dailyLimit} is used up`]]
      : []),
  ];
  ui.blank();
  console.log(`  ${bold(pale('Before you start'))}`);
  for (const [kind, text] of checks) ui[kind](text);
  ui.blank();

  if (left === 0) {
    ui.info("Come back tomorrow, or raise the daily cap in Settings.");
    return 0;
  }
  if (hoursSince(settings.lastLimitedAt) < 24) {
    const go = await confirm({ message: 'Start anyway?', default: false });
    if (!go) return 0;
  }
  return Math.min(settings.limit || Infinity, left);
}

async function runUnsend({ dryRun }) {
  ui.title(dryRun ? 'Test run (nothing is deleted)' : 'Unsend my messages');
  const target = await chooseConversation();
  if (!target) return;
  const current = await openConversation(target.url);
  if (!current) return;

  const speed = settings.speedProfile;
  let limit;
  if (dryRun) {
    limit = await number({ message: 'How many of your messages to check?', default: 5, min: 1, required: true });
  } else {
    limit = await preflight(current, target);
    if (!limit) {
      ui.info('Nothing was changed.');
      return;
    }
    ui.table([
      ['Conversation', gold(label(target))],
      ['Speed', `${speed.name} ${bronze(`(${speed.summary})`)}`],
      ['Limit', Number.isFinite(limit) ? `${limit} messages` : 'Whole conversation'],
    ]);
    ui.blank();
    ui.warn('This removes your messages for both sides. It cannot be undone.');
    const answer = await input({ message: `Type ${bold('UNSEND')} to start, or press Enter to cancel:` });
    if (answer.trim() !== 'UNSEND') {
      ui.info('Cancelled. Nothing was changed.');
      return;
    }
  }

  ui.blank();
  ui.note('Press Ctrl+C to stop safely. You can minimize the browser window, but do not close it.');
  ui.blank();

  const status = new ui.StatusLine();
  const started = Date.now();
  let count = 0;
  let stopRequested = false;
  let state = () => ivory('Starting');
  const render = () => {
    const elapsed = Date.now() - started;
    const rate = elapsed > 10000 ? `${(count / (elapsed / 60000)).toFixed(1)}/min` : '-';
    status.update(
      [`${bronze(dryRun ? 'Found' : 'Unsent')} ${bold(gold(String(count)))}`, ivory(rate), ivory(ui.duration(elapsed))],
      stopRequested ? amber('Stopping after the current message') : state(),
    );
  };
  const onSigint = async () => {
    if (stopRequested) {
      status.end();
      await closeBrowser();
      process.exit(130);
    }
    stopRequested = true;
    render();
  };
  const onEvent = (event) => {
    if (event.type === 'unsent' || event.type === 'found') count = event.count;
    if (event.type === 'loading') state = () => ivory('Loading older messages');
    else if (event.type === 'reverted') {
      if (event.count !== undefined) count = event.count;
      state = () => amber('Instagram put a message back');
    } else if (event.type === 'checking') state = () => ivory('Checking nothing came back');
    else if (event.type === 'pause') {
      const until = Date.now() + event.seconds * 1000;
      const why = event.reason === 'reverted' ? 'Instagram put a message back, waiting' : 'Short break to avoid a block';
      state = () => (event.reason === 'reverted' ? amber : ivory)(`${why} (${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s)`);
    } else state = () => ivory('Working');
    render();
  };

  process.on('SIGINT', onSigint);
  const timer = setInterval(render, 250);
  let stats;
  try {
    // A test run deletes nothing, so it does not need to wait between messages.
    const pace = dryRun ? { minDelay: 300, maxDelay: 800 } : speed;
    stats = await unsendThread(current, { ...pace, dryRun, limit, shouldStop: () => stopRequested, onEvent });
  } finally {
    clearInterval(timer);
    process.off('SIGINT', onSigint);
    render();
    status.end();
  }

  ui.blank();
  // A run that stopped at the daily cap rather than the per-run limit.
  if (stats.stoppedBy === 'limit' && !dryRun && settings.dailyLimit && limit < (settings.limit || Infinity)) {
    stats.stoppedBy = 'daily';
  }
  const [kind, reason] = REASONS[stats.stoppedBy] ?? ['info', stats.stoppedBy];
  const tint = { ok: sage, warn: amber, fail: ui.wine }[kind] ?? ivory;
  ui.ledger(dryRun ? 'Test run' : 'The record', [
    [dryRun ? 'Your messages found' : 'Unsent', bold(gold(String(dryRun ? stats.found : stats.unsent)))],
    ...(stats.reverted ? [['Put back by Instagram', amber(String(stats.reverted))]] : []),
    ...(stats.unconfirmed ? [['Not confirmed', amber(String(stats.unconfirmed))]] : []),
    ...(stats.skipped ? [['Had no Unsend option', ivory(String(stats.skipped))]] : []),
    ['Time', ivory(ui.duration(Date.now() - started))],
    ['Ended', tint(kind === 'ok' ? 'Completed' : kind === 'warn' ? 'Stopped' : 'Interrupted')],
  ]);
  ui.blank();
  ui[kind](reason);
  for (const text of stats.notices) ui.note(`Instagram said: "${text}"`);
  if (stats.stoppedBy === 'refused') {
    ui.blank();
    ui.note('Unsend one message of this conversation in the Instagram app on your phone:');
    ui.note('  It works there: this conversation cannot be unsent from the web. Use the phone for it.');
    ui.note('  It comes back there too: your account is limited. Wait 24 hours before trying again.');
    ui.note('Either way, do not try other conversations now: every attempt counts against the account.');
  } else if (stats.unsent + stats.found === 0 && stats.stoppedBy !== 'stopped') {
    ui.warn('Nothing was found. Run Diagnose from the menu and send the report.');
  } else if (dryRun) {
    ui.info('It works. Choose "Unsend my messages" from the menu to do it for real.');
  }
  if (!dryRun) {
    settings.lastRunAt = new Date().toISOString();
    if (['refused', 'limited', 'blocked'].includes(stats.stoppedBy)) settings.lastLimitedAt = settings.lastRunAt;
  }
  await settings.remember(target.url, { name: target.name, unsent: stats.unsent, tested: dryRun && stats.found > 0 });
}

async function diagnose() {
  ui.title('Diagnose');
  ui.note('Saves the structure and button names of the page to a file, to fix the tool if Instagram changed.');
  ui.note('The file has no message text.');
  ui.blank();
  const target = await chooseConversation();
  if (!target) return;
  const current = await openConversation(target.url);
  if (!current) return;
  const report = await inspect(current, DEBUG);
  ui.blank();
  ui.table([
    ['Messages on screen', String(report.rows)],
    ['Yours', String(report.yourRows)],
    ['Report', report.file],
  ]);
  ui.blank();
  if (report.yourRows === 0) ui.warn('None of your messages were recognized. Send the report file for a fix.');
  else ui.ok('Your messages are recognized.');
}

async function settingsMenu() {
  while (true) {
    ui.title('Settings');
    const speed = settings.speedProfile;
    const choice = await select({
      message: 'Change a setting:',
      choices: [
        { name: `Speed               ${gold(speed.name)}`, short: 'Speed', value: 'speed', description: speed.summary },
        {
          name: `Messages per run    ${gold(settings.limit ? String(settings.limit) : 'No limit')}`,
          short: 'Messages per run',
          value: 'limit',
          description: 'Stop after this many messages, to spread a big conversation over several days',
        },
        {
          name: `Daily cap           ${gold(settings.dailyLimit ? String(settings.dailyLimit) : 'No cap')}`,
          short: 'Daily cap',
          value: 'daily',
          description: `Most messages to unsend in one day, across all runs (${settings.unsentToday} today)`,
        },
        { name: 'Back', value: 'back' },
      ],
    });
    if (choice === 'back') return;
    if (choice === 'speed') {
      settings.speed = await select({
        message: 'Speed:',
        default: settings.speed,
        choices: Object.entries(SPEEDS).map(([value, s]) => ({
          name: value === 'safe' ? `${s.name} ${bronze('(recommended)')}` : s.name,
          value,
          description: s.summary,
        })),
      });
    } else if (choice === 'daily') {
      settings.dailyLimit = await number({
        message: 'Most messages to unsend in a day (0 = no cap):',
        default: settings.dailyLimit,
        min: 0,
        step: 1,
        required: true,
      });
    } else {
      settings.limit = await number({
        message: 'Max messages per run (0 = no limit):',
        default: settings.limit,
        min: 0,
        step: 1,
        required: true,
      });
    }
    await settings.save();
    ui.ok('Saved.');
  }
}

async function logOut() {
  ui.title('Log out');
  if (!existsSync(PROFILE)) {
    ui.info('There is no saved login on this computer.');
    return;
  }
  const sure = await confirm({ message: 'Log out and delete the saved Instagram login on this computer?', default: false });
  if (!sure) return;
  await closeBrowser();
  await rm(PROFILE, { recursive: true, force: true });
  ui.ok('Logged out. You will log in again next time.');
}

function help() {
  ui.title('How it works');
  const steps = [
    'Choose "Test run" first. A browser window opens; log in to Instagram there the first time.',
    'Pick the conversation: paste its link, or open it in the browser window.',
    'If the test finds your messages, choose "Unsend my messages" and type UNSEND.',
    'Leave the browser window open (minimizing is fine). Ctrl+C stops safely; running again continues.',
  ];
  steps.forEach((step, i) => console.log(`  ${gold(`${['I', 'II', 'III', 'IV'][i]}.`.padEnd(4))} ${ivory(step)}`));
  ui.title('Good to know');
  [
    'Only your own messages can be unsent. The other person\'s messages stay.',
    'Unsending is permanent. It does not undo screenshots or downloads the other person made.',
    'Instagram limits how fast you can act. If it says "Try again later", wait a day and use the Safe speed.',
    'If a message vanishes and comes right back, Instagram refused the unsend. The tool stops at once.',
    'Do one conversation per sitting. Testing several in a row is what gets an account limited.',
    'Automating Instagram is against its Terms of Use. The tool is slow on purpose, but the risk is not zero.',
    'Keep Instagram in English for the best results.',
  ].forEach((line) => console.log(`  ${gold('♦')} ${ivory(line)}`));
}

// ---------- Main menu ----------

export async function main() {
  await settings.load();
  try {
    while (true) {
      ui.banner(VERSION, ui.ribbon([
        ['Speed', settings.speedProfile.name],
        ['Limit', settings.limit ? String(settings.limit) : 'None'],
        ['Today', settings.dailyLimit ? `${settings.unsentToday}/${settings.dailyLimit}` : String(settings.unsentToday)],
        ['Saved login', existsSync(PROFILE) ? 'Yes' : 'No'],
      ]));
      const action = await select({
        message: 'What do you want to do?',
        pageSize: 10,
        choices: [
          { name: 'Test run', value: 'test', description: 'Check a few of your messages in a conversation. Nothing is deleted.' },
          { name: 'Unsend my messages', value: 'unsend', description: 'Unsend your messages in a conversation, for both sides.' },
          ui.divider(),
          { name: 'Settings', value: 'settings', description: 'Speed and messages per run.' },
          { name: 'Diagnose', value: 'diagnose', description: 'Save a report if the tool cannot find your messages.' },
          { name: 'Log out', value: 'logout', description: 'Delete the saved Instagram login on this computer.' },
          { name: 'Help', value: 'help', description: 'How to use it, and what to know before you start.' },
          ui.divider(),
          { name: 'Exit', value: 'exit' },
        ],
      });
      if (action === 'exit') break;

      try {
        if (action === 'test') await runUnsend({ dryRun: true });
        else if (action === 'unsend') await runUnsend({ dryRun: false });
        else if (action === 'settings') await settingsMenu();
        else if (action === 'diagnose') await diagnose();
        else if (action === 'logout') await logOut();
        else help();
      } catch (error) {
        if (error.name === 'ExitPromptError') throw error;
        ui.blank();
        ui.fail(/has been closed/i.test(error.message) ? 'The browser window was closed.' : error.message.split('\n')[0]);
      }
      if (action !== 'settings') {
        ui.blank();
        await input({ message: 'Press Enter to return to the menu' });
      }
    }
  } catch (error) {
    if (error.name !== 'ExitPromptError') throw error;
  } finally {
    await closeBrowser();
  }
  console.log(`\n  ${gold('♦')} ${pale('Vale.')} ${bronze('Farewell.')}\n`);
}
