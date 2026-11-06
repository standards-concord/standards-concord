/**
 * unpack-voice.sh and seed-voice.sh put narration from an archive into the voice cache,
 * which the recorder then trusts and writes into. A features run's narration was kept only
 * in its run's artifact, so walkthrough.yml can seed the cache from an earlier run; these
 * check that only plain files from a trusted run of this workflow get in. An archive with
 * a symlink at a name the recorder later writes to (`<key>.mp3.part.mp3`) would otherwise
 * redirect that write outside the cache.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.resolve(import.meta.dirname, '..');
const unpackScript = path.join(here, 'unpack-voice.sh');
const seedScript = path.join(here, 'seed-voice.sh');

type Entry = { name: string; type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'chardev' | 'blockdev' | 'fifo'; body?: string; link?: string };

/** A gzipped tar holding exactly these entries, written by hand so any name or type can be tried. */
function tarball(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.type === 'file' || !e.type ? (e.body ?? '') : '');
    const h = Buffer.alloc(512);
    const put = (s: string, at: number, len: number) => h.write(s, at, Math.min(len, Buffer.byteLength(s)), 'utf8');
    const octal = (n: number, at: number, len: number) => put(n.toString(8).padStart(len - 1, '0') + '\0', at, len);
    put(e.name, 0, 100);
    octal(e.type === 'dir' ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(body.length, 124, 12);
    octal(1_700_000_000, 136, 12);
    put({ file: '0', hardlink: '1', symlink: '2', chardev: '3', blockdev: '4', dir: '5', fifo: '6' }[e.type ?? 'file'], 156, 1);
    if (e.link) put(e.link, 157, 100);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Every path under dir, relative, with links marked. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => (lstatSync(path.join(dir, p)).isSymbolicLink() ? `${p} (link)` : p))
    .sort();
}

let root: string;
let cache: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'seed-voice-'));
  cache = path.join(root, 'cache');
  outside = path.join(root, 'outside');
  mkdirSync(outside);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const archive = (entries: Entry[]) => {
  const file = path.join(root, `voice-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(file, tarball(entries));
  return file;
};
/** Runs unpack-voice.sh from root, as walkthrough.yml does from the checkout, into a relative cache path. */
const unpack = (file: string, to = 'cache', env: NodeJS.ProcessEnv = process.env) => spawnSync('bash', [unpackScript, file, to], { encoding: 'utf8', cwd: root, env });

describe('unpack-voice.sh', () => {
  it('adds plain files and keeps the ones already in the cache', () => {
    mkdirSync(path.join(cache, 'elevenlabs'), { recursive: true });
    writeFileSync(path.join(cache, 'elevenlabs', 'old.mp3'), 'mine');
    const r = unpack(archive([
      { name: './', type: 'dir' },
      { name: './elevenlabs/', type: 'dir' },
      { name: './elevenlabs/old.mp3', body: 'theirs' },
      { name: './elevenlabs/new.mp3', body: 'audio' },
      { name: './elevenlabs/new.mp3.timing.json', body: '[0,1]' },
    ]));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(cache, 'elevenlabs', 'old.mp3'), 'utf8')).toBe('mine');
    expect(readFileSync(path.join(cache, 'elevenlabs', 'new.mp3'), 'utf8')).toBe('audio');
    expect(tree(cache)).toEqual(['elevenlabs', 'elevenlabs/new.mp3', 'elevenlabs/new.mp3.timing.json', 'elevenlabs/old.mp3']);
  });

  const refused: [string, (outside: string) => Entry[]][] = [
    ['an absolute path', (o) => [{ name: `${o}/evil.mp3`, body: 'x' }]],
    ['a path with ..', () => [{ name: 'elevenlabs/../../outside/evil.mp3', body: 'x' }]],
    ['a symlink pointing out of the cache', (o) => [{ name: 'elevenlabs/k.mp3.part.mp3', type: 'symlink', link: `${o}/target` }]],
    ['a symlink pointing inside it', () => [{ name: 'elevenlabs/a.mp3', type: 'symlink', link: 'b.mp3' }]],
    ['a hard link', (o) => [{ name: 'elevenlabs/h.mp3', type: 'hardlink', link: `${o}/target` }]],
    ['a character device', () => [{ name: 'elevenlabs/c.mp3', type: 'chardev' }]],
    ['a block device', () => [{ name: 'elevenlabs/b.mp3', type: 'blockdev' }]],
    ['a named pipe', () => [{ name: 'elevenlabs/p.mp3', type: 'fifo' }]],
  ];
  for (const [what, entries] of refused) {
    it(`refuses a whole archive holding ${what}, writing nothing`, () => {
      writeFileSync(path.join(outside, 'target'), 'outside');
      const r = unpack(archive([{ name: 'elevenlabs/fine.mp3', body: 'ok' }, ...entries(outside)]));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/::error::/);
      expect(tree(cache)).toEqual([]);
      expect(tree(outside)).toEqual(['target']);
      expect(readFileSync(path.join(outside, 'target'), 'utf8')).toBe('outside');
    });
  }

  it('refuses to add to a cache that already holds a link', () => {
    mkdirSync(path.join(cache, 'elevenlabs'), { recursive: true });
    symlinkSync(outside, path.join(cache, 'elevenlabs', 'sub'));
    const r = unpack(archive([{ name: 'elevenlabs/sub/evil.mp3', body: 'x' }]));
    expect(r.status).not.toBe(0);
    expect(tree(outside)).toEqual([]);
  });

  // r2 review: the cache was created and scanned through a link in its own path, so the
  // copy followed it out of the checkout.
  it('refuses a cache that is itself a link, creating nothing', () => {
    symlinkSync(outside, cache);
    const r = unpack(archive([{ name: 'elevenlabs/a.mp3', body: 'x' }]));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is a link/);
    expect(tree(outside)).toEqual([]);
  });

  it('refuses a cache with a link among its parents, creating nothing', () => {
    symlinkSync(outside, path.join(root, 'walkthrough'));
    const r = unpack(archive([{ name: 'elevenlabs/a.mp3', body: 'x' }]), 'walkthrough/.cache/voice');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is a link/);
    expect(tree(outside)).toEqual([]);
  });

  it('refuses a cache path that is absolute or has ..', () => {
    for (const to of [cache, '../cache', 'a/../cache']) {
      const r = unpack(archive([{ name: 'elevenlabs/a.mp3', body: 'x' }]), to);
      expect(r.status, to).not.toBe(0);
    }
    expect(tree(cache)).toEqual([]);
  });

  // r2 review: a folder the scan couldn't read could hide a link, and the scan's failure was ignored.
  it('fails closed when it cannot check everything in the cache', () => {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // A find that reads nothing and reports a failure, as one does on an unreadable folder.
    writeFileSync(path.join(bin, 'find'), '#!/usr/bin/env bash\necho "find: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const r = unpack(archive([{ name: 'elevenlabs/a.mp3', body: 'x' }]), 'cache', { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Couldn't check everything/);
    expect(tree(cache)).toEqual([]);
  });

  it('refuses a cache with a link hidden in a folder it cannot read', () => {
    const hidden = path.join(cache, 'elevenlabs', 'hidden');
    mkdirSync(hidden, { recursive: true });
    symlinkSync(outside, path.join(hidden, 'out'));
    chmodSync(hidden, 0o311);
    try {
      const r = unpack(archive([{ name: 'elevenlabs/hidden/out/evil.mp3', body: 'x' }]));
      expect(r.status).not.toBe(0);
      expect(tree(outside)).toEqual([]);
    } finally {
      chmodSync(hidden, 0o755);
    }
  });
});

describe('seed-voice.sh', () => {
  const REPO = 'standards-concord/standards-concord';
  const trusted = { path: '.github/workflows/walkthrough.yml', event: 'workflow_dispatch', head_repository: { full_name: REPO } };

  /** Runs the script with a stand-in gh that answers the run lookup and serves the artifact. */
  function seed(runId: string, run: object, voice: string) {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(root, 'run.json'), JSON.stringify(run));
    const log = path.join(root, 'gh.log');
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1" = api ]; then cat "${root}/run.json"; exit 0; fi
if [ "$1 $2" = "run download" ]; then
  while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
  mkdir -p "$dir" && cp "${voice}" "$dir/walkthrough-voice.tar.gz"; exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [seedScript, runId, 'cache'], { encoding: 'utf8', cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO } });
    return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  }

  it('seeds the cache from a walkthrough run of this repository', () => {
    const r = seed('42044600539', trusted, archive([{ name: 'elevenlabs/a.mp3', body: 'audio' }]));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([`api repos/${REPO}/actions/runs/42044600539`, `run download 42044600539 --repo ${REPO} --name concord-walkthrough --dir ${r.calls[1]?.split('--dir ')[1]}`]);
    expect(tree(cache)).toEqual(['elevenlabs', 'elevenlabs/a.mp3']);
  });

  it('accepts a run started by a release', () => {
    const r = seed('7', { ...trusted, event: 'release' }, archive([{ name: 'elevenlabs/a.mp3', body: 'audio' }]));
    expect(r.status, r.stderr).toBe(0);
  });

  it('refuses a run id that is not just digits, before asking GitHub anything', () => {
    for (const id of ['', '12a', '1;touch x', '../1']) {
      const r = seed(id, trusted, archive([{ name: 'elevenlabs/a.mp3' }]));
      expect(r.status).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });

  const untrusted: [string, object][] = [
    ['another workflow', { ...trusted, path: '.github/workflows/ci.yml' }],
    ['a pull request', { ...trusted, event: 'pull_request' }],
    ['a pull_request_target run', { ...trusted, event: 'pull_request_target' }],
    ['a fork', { ...trusted, head_repository: { full_name: 'someone/standards-concord' } }],
    ['a run with no details', {}],
  ];
  for (const [what, run] of untrusted) {
    it(`refuses narration from ${what}, without downloading it`, () => {
      const r = seed('5', run, archive([{ name: 'elevenlabs/a.mp3', body: 'audio' }]));
      expect(r.status).not.toBe(0);
      expect(r.calls.some((c) => c.startsWith('run download'))).toBe(false);
      expect(tree(cache)).toEqual([]);
    });
  }

  it('refuses a trusted run whose archive holds a link', () => {
    const r = seed('5', trusted, archive([{ name: 'elevenlabs/k.mp3.part.mp3', type: 'symlink', link: `${outside}/x` }]));
    expect(r.status).not.toBe(0);
    expect(tree(cache)).toEqual([]);
  });
});
