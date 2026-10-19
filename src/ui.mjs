// Terminal look and feel: a gold-on-dark theme with double-line frames and
// DOS-era block lettering. Every glyph used here also renders in Windows cmd.

import pc from 'picocolors';
import readline from 'node:readline';
import { Separator } from '@inquirer/prompts';

const out = process.stdout;
const trueColor = pc.isColorSupported && (out.getColorDepth?.() ?? 1) >= 24;

// A 24-bit color, or the closest basic color when the terminal has no 24-bit support.
const rgb = (r, g, b, fallback) => (text) =>
  trueColor ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m` : fallback(String(text));

export const color = {
  gold: rgb(212, 175, 55, pc.yellow),
  pale: rgb(240, 218, 150, pc.yellow),
  bronze: rgb(150, 122, 72, pc.dim),
  ivory: rgb(245, 236, 215, pc.white),
  sage: rgb(150, 190, 120, pc.green),
  amber: rgb(232, 160, 60, pc.yellow),
  wine: rgb(205, 85, 95, pc.red),
  bold: pc.bold,
};
const { gold, pale, bronze, ivory, sage, amber, wine, bold } = color;

const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');
const visible = (text) => strip(text).length;
const width = () => out.columns || 80;
const center = (text, size) => {
  const space = Math.max(0, size - visible(text));
  return ' '.repeat(Math.floor(space / 2)) + text + ' '.repeat(Math.ceil(space / 2));
};

function roman(year) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let result = '';
  for (const [value, letters] of map) while (year >= value) { result += letters; year -= value; }
  return result;
}

// ---------- Frames ----------

// A double-line frame. lines are centered unless align is 'left'.
export function frame(lines, { size, align = 'center', tint = gold } = {}) {
  const inner = size ?? Math.max(...lines.map(visible)) + 4;
  const body = (line) => (align === 'center' ? center(line, inner) : `  ${line}${' '.repeat(Math.max(0, inner - 2 - visible(line)))}`);
  console.log(`  ${tint(`╔${'═'.repeat(inner)}╗`)}`);
  for (const line of lines) console.log(`  ${tint('║')}${body(line)}${tint('║')}`);
  console.log(`  ${tint(`╚${'═'.repeat(inner)}╝`)}`);
}

const LETTERS = [
  '██╗ ██████╗     ██╗   ██╗███╗   ██╗███████╗███████╗███╗   ██╗██████╗ ',
  '██║██╔════╝     ██║   ██║████╗  ██║██╔════╝██╔════╝████╗  ██║██╔══██╗',
  '██║██║  ███╗    ██║   ██║██╔██╗ ██║███████╗█████╗  ██╔██╗ ██║██║  ██║',
  '██║██║   ██║    ██║   ██║██║╚██╗██║╚════██║██╔══╝  ██║╚██╗██║██║  ██║',
  '██║╚██████╔╝    ╚██████╔╝██║ ╚████║███████║███████╗██║ ╚████║██████╔╝',
  '╚═╝ ╚═════╝      ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚══════╝╚═╝  ╚═══╝╚═════╝ ',
];
// Pale gold at the top to deep bronze at the bottom.
const SHADES = [[245, 225, 160], [236, 205, 120], [224, 186, 82], [208, 165, 56], [182, 140, 46], [150, 112, 40]];

export function banner(version, ribbon) {
  console.clear();
  console.log();
  const motto = `${gold('♦')}  ${pale('Quod scripsi, delevi')}  ${gold('♦')}`;
  const meaning = bronze('What I wrote, I have erased');
  const edition = bronze(`─── v${version} · Anno ${roman(new Date().getFullYear())} ───`);
  if (width() >= 80) {
    const shade = (line, i) => (trueColor ? rgb(...SHADES[i], pc.yellow)(line) : gold(line));
    frame(['', ...LETTERS.map(shade), '', motto, meaning, '', edition, ''], { size: LETTERS[0].length + 6 });
  } else {
    frame(['', bold(pale('I G   U N S E N D')), '', motto, meaning, '', edition, ''], { size: Math.max(44, width() - 6) });
  }
  if (ribbon) console.log(`\n  ${ribbon}\n`);
}

// "Speed ♦ Safe   ·   Limit ♦ None"
export const ribbon = (pairs) =>
  pairs.map(([label, value]) => `${bronze(label)} ${gold('♦')} ${ivory(value)}`).join(bronze('    ·    '));

export function title(text) {
  const spaced = text.toUpperCase().split('').join(' ');
  console.log(`\n  ${gold('═══════')} ${gold('♦')} ${bold(pale(spaced))} ${gold('♦')} ${gold('═══════')}\n`);
}

// ---------- Lines ----------

// Icons sit in the left gutter, in line with the prompts' ♦; text starts at column 2.
export const info = (text) => console.log(`${gold('·')} ${ivory(text)}`);
export const ok = (text) => console.log(`${sage('√')} ${ivory(text)}`);
export const warn = (text) => console.log(`${amber('‼')} ${ivory(text)}`);
export const fail = (text) => console.log(`${wine('×')} ${ivory(text)}`);
export const note = (text) => console.log(`  ${bronze(text)}`);
export const blank = () => console.log();

// Label/value rows with dotted leaders, e.g. "Unsent ........ 120".
export function table(rows) {
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 4;
  for (const [label, value] of rows) {
    console.log(`  ${bronze(label)} ${bronze('.'.repeat(labelWidth - label.length))} ${ivory(value)}`);
  }
}

// A framed record of a finished run.
export function ledger(heading, rows) {
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 3;
  const lines = rows.map(([label, value]) => `${bronze(label)} ${bronze('.'.repeat(labelWidth - label.length))} ${value}`);
  const size = Math.min(Math.max(...lines.map(visible), heading.length * 2) + 6, width() - 6);
  frame([center(bold(pale(heading.toUpperCase().split('').join(' '))), size - 4), bronze('─'.repeat(size - 4)), ...lines], { size, align: 'left' });
}

export function duration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// ---------- Prompts ----------

export const theme = {
  prefix: { idle: gold('♦'), done: bronze('♦') },
  icon: { cursor: gold('►') },
  indexMode: 'number',
  style: {
    message: (text, status) => (status === 'done' ? bronze(text) : bold(ivory(text))),
    answer: (text) => gold(text),
    highlight: (text) => bold(gold(text)),
    description: (text) => `${bronze('»')} ${pale(text)}`,
    defaultAnswer: (text) => bronze(`(${text})`),
    error: (text) => wine(`  × ${text}`),
    help: (text) => bronze(text),
    key: (text) => gold(text),
    keysHelpTip: () => bronze('\n  ↑↓ move  ·  number to jump  ·  Enter to choose'),
  },
};

export const divider = () => new Separator(bronze('  ─────── ♦ ───────'));

// ---------- Live status ----------

const SPINNER = ['|', '/', '─', '\\'];

// A single line that is redrawn in place while a run is going.
export class StatusLine {
  frame = 0;

  update(parts, state) {
    if (!out.isTTY) return;
    const spin = gold(SPINNER[this.frame++ % SPINNER.length]);
    const text = `${gold('►')} ${parts.join(bronze('   ·   '))}${bronze('   ·   ')}${state} ${spin}`;
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
    const max = width() - 1;
    out.write(visible(text) > max ? strip(text).slice(0, max) : text);
  }

  end() {
    if (out.isTTY) out.write('\n');
  }
}

export { gold, pale, bronze, ivory, sage, amber, wine, bold };
