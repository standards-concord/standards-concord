import { afterEach, describe, expect, it } from 'vitest';
import { get, put, remove } from '../src/db.js';
import { runStartupTasks, startupTaskDone, type StartupTask } from '../src/startup.js';

/**
 * Start-up work on Vercel (step 5): there is no single start, so every new function instance ran the migrations,
 * the demo seed and the release-page refresh again, several instances at once. Each task now records that it is
 * done, one instance runs them at a time, and a deployment skips what it (or a newer version) already did.
 */
const names: string[] = [];
const task = (run: StartupTask['run'] = async () => undefined): StartupTask & { calls: number } => {
  const name = `t-${Date.now()}-${names.length}`;
  names.push(name);
  const t = { name, calls: 0, run: async () => (t.calls++, run()) };
  return t;
};
afterEach(async () => {
  for (const n of names.splice(0)) await remove('kv', `startup:${n}`);
  await remove('kv', 'lease:startup');
});

describe('start-up tasks', () => {
  it('runs each task once per deployment, then skips it at the next instance', async () => {
    const a = task();
    const b = task();
    expect(await startupTaskDone(a.name, '1.0.0')).toBe(false);
    expect(await runStartupTasks([a, b], { appVersion: '1.0.0' })).toEqual([a.name, b.name]);
    expect(await startupTaskDone(a.name, '1.0.0')).toBe(true);
    expect(await startupTaskDone(a.name, '1.0.1')).toBe(false);
    expect(await runStartupTasks([a, b], { appVersion: '1.0.0' })).toEqual([]);
    expect([a.calls, b.calls]).toEqual([1, 1]);
    expect(await get('kv', `startup:${a.name}`)).toMatchObject({ appVersion: '1.0.0', deployment: 'local' });
  });

  it('runs a task again for a newer app version, but not for an older one still serving', async () => {
    const a = task();
    await runStartupTasks([a], { appVersion: '1.1.0' });
    await runStartupTasks([a], { appVersion: '1.0.9' }); // the previous deployment, still running somewhere
    expect(a.calls).toBe(1);
    await runStartupTasks([a], { appVersion: '1.2.0' });
    expect(a.calls).toBe(2);
  });

  it('runs a task again when this deployment is a different one at the same version (a redeploy)', async () => {
    const a = task();
    await put('kv', { id: `startup:${a.name}`, appVersion: '1.0.0', deployment: 'dpl_previous', at: new Date().toISOString() });
    await runStartupTasks([a], { appVersion: '1.0.0' });
    expect(a.calls).toBe(1);
  });

  it('tries a task again later when it throws or says it is not finished, and still runs the rest', async () => {
    let fail = true;
    const flaky = task(async () => {
      if (fail) throw new Error('pod unreachable');
    });
    const unfinished = task(async () => !fail);
    const fine = task();
    expect(await runStartupTasks([flaky, unfinished, fine], { appVersion: '1.0.0' })).toEqual([fine.name]);
    fail = false;
    expect(await runStartupTasks([flaky, unfinished, fine], { appVersion: '1.0.0' })).toEqual([flaky.name, unfinished.name]);
    expect([flaky.calls, unfinished.calls, fine.calls]).toEqual([2, 2, 1]);
  });

  it('leaves the tasks to another instance that is already running them', async () => {
    const a = task();
    let release!: () => void;
    const holding = runStartupTasks([task(() => new Promise<void>((r) => (release = r)))], { appVersion: '1.0.0' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await runStartupTasks([a], { appVersion: '1.0.0' })).toBeUndefined();
    expect(a.calls).toBe(0);
    release();
    await holding;
    await runStartupTasks([a], { appVersion: '1.0.0' });
    expect(a.calls).toBe(1);
  });

  it('runs everything at every start on one server (the VM), done or not', async () => {
    const a = task();
    await runStartupTasks([a], { appVersion: '1.0.0' });
    await runStartupTasks([a], { appVersion: '1.0.0', always: true });
    expect(a.calls).toBe(2);
  });
});
