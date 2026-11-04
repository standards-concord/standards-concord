/**
 * Drives stage/terminal.html. Every call is remembered, so when a scene goes back to
 * the browser and later returns to the terminal, the session so far is redrawn
 * instantly and carries on: it looks like one continuous terminal session.
 */
import type { Director } from './director.ts';

type Op = { fn: string; args: unknown[] };

const ANIMATED: Record<string, number> = { shell: 1, ask: 1, say: 1 };

export interface DiffRow {
  t: 'ctx' | 'add' | 'del';
  n?: number;
  s: string;
}

export class Terminal {
  private history: Op[] = [];

  constructor(
    private readonly d: Director,
    private readonly url: string,
  ) {}

  private async call(fn: string, args: unknown[], remember = true) {
    if (remember) this.history.push({ fn, args });
    await this.d.page.evaluate(([f, a]) => (window as any).term[f as string](...(a as unknown[])), [fn, args] as const);
  }

  /** Opens the terminal page and redraws the session so far. */
  async open() {
    await this.d.goto(this.url, { settle: false });
    await this.d.page.waitForFunction(() => !!(window as any).term);
    for (const op of this.history) {
      if (op.fn === 'think') continue;
      const args = [...op.args];
      if (ANIMATED[op.fn]) args[1] = { ...((args[1] as object) ?? {}), cps: 0 };
      await this.call(op.fn, args, false);
    }
    // Keyboard only in the terminal: hide the pointer.
    await this.d.page.evaluate(() => (window as any).__wt?.cursorVisible(false));
  }

  title(t: string) {
    return this.call('title', [t]);
  }
  clear() {
    this.history = [];
    return this.call('clear', [], false);
  }
  blank(n = 1) {
    return this.call('blank', [n]);
  }
  print(text: string, cls?: string) {
    return this.call('print', [text, cls]);
  }
  html(h: string, cls?: string) {
    return this.call('html', [h, cls]);
  }
  shell(cmd: string, opts: { cps?: number; cwdLabel?: string } = {}) {
    return this.call('shell', [cmd, opts]);
  }
  startAgent(opts: { version?: string; model?: string; cwdPath?: string } = {}) {
    return this.call('startAgent', [opts]);
  }
  ask(text: string, opts: { cps?: number } = {}) {
    return this.call('ask', [text, opts]);
  }
  think(ms = 1400, word = 'Thinking') {
    return this.call('think', [ms, word]);
  }
  say(text: string, opts: { cps?: number } = {}) {
    return this.call('say', [text, opts]);
  }
  tool(label: string, args?: string) {
    return this.call('tool', [label, args]);
  }
  result(text: string, opts: { max?: number } = {}) {
    return this.call('result', [text, opts]);
  }
  diff(file: string, summary: string, rows: DiffRow[]) {
    return this.call('diff', [file, summary, rows]);
  }
}

/** A minimal line diff (longest common subsequence) for showing edits. */
export function lineDiff(before: string, after: string, context = 2): DiffRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ t: 'ctx', n: j + 1, s: b[j] });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) {
      rows.push({ t: 'del', n: i + 1, s: a[i] });
      i++;
    } else {
      rows.push({ t: 'add', n: j + 1, s: b[j] });
      j++;
    }
  }
  // Keep only changes with a little context, and mark gaps.
  const keep = rows.map((r, k) => r.t !== 'ctx' || rows.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== 'ctx'));
  const out: DiffRow[] = [];
  rows.forEach((r, k) => {
    if (keep[k]) out.push(r);
    else if (out.length && out.at(-1)!.s !== '…') out.push({ t: 'ctx', s: '…' });
  });
  while (out.length && out[0].s === '…') out.shift();
  while (out.length && out.at(-1)!.s === '…') out.pop();
  return out;
}

export function countChanges(rows: DiffRow[]) {
  const add = rows.filter((r) => r.t === 'add').length;
  const del = rows.filter((r) => r.t === 'del').length;
  return `${add ? `Added ${add} line${add === 1 ? '' : 's'}` : ''}${add && del ? ', ' : ''}${del ? `removed ${del} line${del === 1 ? '' : 's'}` : ''}`;
}
