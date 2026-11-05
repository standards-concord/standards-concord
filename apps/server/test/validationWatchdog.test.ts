import { fork, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Whether a process is gone: no such process, or one that has exited and only waits to be reaped. */
function gone(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return true;
  }
}

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe.skipIf(process.platform !== 'linux')('a validation worker stuck in synchronous work', () => {
  it('kills itself when its job runs past its deadline', async () => {
    const t = performance.now();
    const child = fork(fixture('busyWorker.mjs'), ['deadline', '300'], { execArgv: [] });
    const signal = await new Promise((resolve) => child.on('exit', (_code, sig) => resolve(sig)));
    expect(signal).toBe('SIGKILL');
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('kills itself when the server is gone, even killed without cleaning up', async () => {
    const parent = spawn(process.execPath, [fixture('parentOfBusy.mjs').pathname], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    parent.stdout.on('data', (d) => (out += d));
    await new Promise((resolve) => parent.on('exit', resolve));
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    const t = performance.now();
    while (!gone(pid) && performance.now() - t < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(gone(pid)).toBe(true);
  });
});
