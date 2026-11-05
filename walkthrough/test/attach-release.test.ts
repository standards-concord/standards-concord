/**
 * walkthrough/attach-release.sh, run against a stand-in `gh` that logs its calls. The
 * review found a failed tag lookup skipped the check that an existing tag is the commit
 * the videos were recorded from, so the videos could be attached to the wrong release.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../attach-release.sh');

interface Gh {
  /** What `git/matching-refs` prints, or 'fail'. */
  refs: string | 'fail';
  /** What `commits/refs/tags/…` prints, or 'fail'. */
  commit?: string | 'fail';
  release?: boolean;
}

function run(gh: Gh, env: { TAG?: string; SHA?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  mkdirSync(path.join(dir, 'bin'));
  mkdirSync(path.join(dir, 'out'));
  for (const v of ['concord-walkthrough', 'concord-feedback'])
    for (const ext of ['mp4', 'vtt', 'transcript.md', 'chapters.txt']) writeFileSync(path.join(dir, 'out', `${v}.${ext}`), '');
  writeFileSync(path.join(dir, 'out', 'walkthrough-voice.tar.gz'), '');
  const out = (v: string | undefined) => (v === 'fail' ? 'echo "HTTP 502" >&2; exit 1' : `echo '${v ?? ''}'`);
  writeFileSync(
    path.join(dir, 'bin', 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "api repos/x/y/git/matching-refs/"*) ${out(gh.refs)};;
  "api repos/x/y/commits/"*) ${out(gh.commit)};;
  "release view") ${gh.release ? 'exit 0' : 'exit 1'};;
  *) exit 0;;
esac
`,
  );
  chmodSync(path.join(dir, 'bin', 'gh'), 0o755);
  const r = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, REPO: 'x/y', TAG: env.TAG ?? 'v0.18.0', SHA: env.SHA ?? 'aaa111' },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  } catch {}
  return { status: r.status, out: r.stdout + r.stderr, calls, writes: calls.filter((c) => /^release (create|upload)/.test(c)) };
}

describe('attaching a recording to a release', () => {
  it('creates a missing tag and release at the recorded commit, then uploads', () => {
    const r = run({ refs: '' });
    expect(r.status).toBe(0);
    expect(r.writes[0]).toMatch(/^release create v0\.18\.0 .*--target aaa111/);
    expect(r.writes[1]).toMatch(/^release upload v0\.18\.0/);
  });

  it('uses an existing tag only when it is the recorded commit', () => {
    const ok = run({ refs: 'refs/tags/v0.18.0', commit: 'aaa111' });
    expect(ok.status).toBe(0);
    expect(ok.writes[0]).toMatch(/--verify-tag/);
    const wrong = run({ refs: 'refs/tags/v0.18.0', commit: 'bbb222', release: true });
    expect(wrong.status).toBe(1);
    expect(wrong.out).toMatch(/v0\.18\.0 is bbb222, but the videos were recorded from aaa111/);
    expect(wrong.writes).toEqual([]);
  });

  it('stops, writing nothing, when a tag lookup fails', () => {
    for (const gh of [{ refs: 'fail' }, { refs: 'refs/tags/v0.18.0', commit: 'fail' }, { refs: 'refs/tags/v0.18.0', commit: '' }] as Gh[]) {
      const r = run({ ...gh, release: true });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/::error::Couldn't/);
      expect(r.writes).toEqual([]);
    }
  });

  it('will not create a release for a tag that isn’t a version', () => {
    const r = run({ refs: '' }, { TAG: 'main' });
    expect(r.status).toBe(1);
    expect(r.writes).toEqual([]);
  });
});
