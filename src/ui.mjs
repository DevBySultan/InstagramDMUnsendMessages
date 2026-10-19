// Terminal output helpers: banner, boxes, a status line that redraws in place.

import pc from 'picocolors';
import readline from 'node:readline';

export { pc };

const out = process.stdout;
const width = () => Math.min(out.columns || 80, 80);

// Visible length, ignoring color codes.
const visible = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (text, size) => text + ' '.repeat(Math.max(0, size - visible(text)));

export function box(lines, { color = pc.cyan } = {}) {
  const inner = Math.max(...lines.map(visible), 20);
  const border = (s) => color(s);
  console.log(border(`  ┌${'─'.repeat(inner + 2)}┐`));
  for (const line of lines) console.log(`  ${border('│')} ${pad(line, inner)} ${border('│')}`);
  console.log(border(`  └${'─'.repeat(inner + 2)}┘`));
}

export function banner(version) {
  console.clear();
  box([
    `${pc.bold('IG Unsend')}  ${pc.dim(`v${version}`)}`,
    pc.dim('Unsend your own Instagram messages, for both sides.'),
  ]);
  console.log();
}

export function title(text) {
  console.log(`\n${pc.bold(pc.cyan('›'))} ${pc.bold(text)}\n`);
}

export const info = (text) => console.log(`  ${pc.cyan('i')} ${text}`);
export const ok = (text) => console.log(`  ${pc.green('✔')} ${text}`);
export const warn = (text) => console.log(`  ${pc.yellow('!')} ${text}`);
export const fail = (text) => console.log(`  ${pc.red('✖')} ${text}`);
export const note = (text) => console.log(`    ${pc.dim(text)}`);

// Label/value rows with dotted leaders, e.g. "Unsent ........ 120".
export function table(rows) {
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 4;
  for (const [label, value] of rows) {
    console.log(`  ${label} ${pc.dim('.'.repeat(labelWidth - label.length))} ${value}`);
  }
}

export function duration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A single line that is redrawn in place while a run is going.
export class StatusLine {
  update(text) {
    if (!out.isTTY) return;
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
    const max = width() - 1;
    out.write(visible(text) > max ? text.replace(/\x1b\[[0-9;]*m/g, '').slice(0, max) : text);
  }

  end() {
    if (out.isTTY) out.write('\n');
  }
}
