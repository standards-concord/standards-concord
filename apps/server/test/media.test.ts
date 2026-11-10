import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The walkthrough videos served at /api/media/. The browser tests (e2e/welcome.spec.ts)
 * use a local folder; the release cache needs GitHub, so it is tested here with a stub.
 */

// The last complete set is kept in the database; a stand-in here, so each test starts with none (afterEach).
const db = vi.hoisted(() => ({ docs: new Map<string, unknown>(), failWrites: false }));
vi.mock('../src/db.js', () => ({
  get: async (_c: string, id: string) => structuredClone(db.docs.get(id)),
  put: async (_c: string, doc: { id: string }) => {
    if (db.failWrites) throw new Error('read-only');
    db.docs.set(doc.id, structuredClone(doc));
    return doc;
  },
}));

const fresh = async () => {
  vi.resetModules();
  return import('../src/services/media.js');
};

/** A release with a complete set of videos; the tour's captions download from `url`. */
const release = (id: number | undefined, tag: string, assetId: number | undefined, url: string) => ({
  id,
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  assets: [
    { id: assetId, name: 'concord-walkthrough.vtt', size: 1, state: 'uploaded', browser_download_url: url },
    ...['concord-walkthrough.mp4', 'concord-feedback.mp4', 'concord-feedback.vtt'].map((name, i) => ({
      id: assetId === undefined ? undefined : assetId * 10 + i,
      name,
      size: 1,
      state: 'uploaded',
      browser_download_url: `${url}/${name}`,
    })),
  ],
});

const cacheDir = async () => path.join((await import('../src/config.js')).config.dataDir, 'media');

function stubGitHub(latest: object | object[], files: Record<string, string>) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('https://api.github.com/')) {
      const all = Array.isArray(latest) ? latest : [latest];
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      const per = Number(new URL(url).searchParams.get('per_page') ?? 30);
      return new Response(JSON.stringify(all.slice((page - 1) * per, page * per)), { status: 200 });
    }
    if (url in files) return new Response(files[url], { status: 200 });
    return new Response('', { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_DIR;
  delete process.env.MEDIA_REPO;
  db.docs.clear();
  db.failWrites = false;
});

describe('media release cache', () => {
  // Cache folders used to be named after the tag with punctuation replaced, so
  // "release/1" and "release_1" shared one, and the newer release served the older file.
  it('keeps each release asset in a folder of its own', async () => {
    stubGitHub(release(101, 'release/1', 1001, 'https://dl.example/a'), { 'https://dl.example/a': 'WEBVTT a' });
    const first = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    expect(fs.readFileSync(first!, 'utf8')).toBe('WEBVTT a');

    stubGitHub(release(102, 'release_1', 1002, 'https://dl.example/b'), { 'https://dl.example/b': 'WEBVTT b' });
    const second = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    expect(second).not.toBe(first);
    expect(fs.readFileSync(second!, 'utf8')).toBe('WEBVTT b');
  });

  it('never serves a symlink planted in the cache', async () => {
    const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-')), 'secret.txt');
    fs.writeFileSync(secret, 'do not serve');
    stubGitHub(release(103, 'v3', 1003, 'https://dl.example/c'), { 'https://dl.example/c': 'WEBVTT c' });
    const media = await fresh();
    const { config } = await import('../src/config.js');
    const folder = path.join(config.dataDir, 'media', 'release-103-asset-1003');
    fs.mkdirSync(folder, { recursive: true });
    fs.symlinkSync(secret, path.join(folder, 'concord-walkthrough.vtt'));
    const served = await media.mediaFile('concord-walkthrough.vtt');
    expect(fs.readFileSync(served!, 'utf8')).toBe('WEBVTT c');
    expect(fs.lstatSync(served!).isSymbolicLink()).toBe(false);
  });
});

describe('media release cache, continued', () => {
  // The folder check used the folder's own resolved path, so an asset folder that was a
  // link to somewhere else passed: only the resolved path under the cache root counts now.
  it('never serves through an asset folder that links outside the cache', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
    fs.writeFileSync(path.join(elsewhere, 'concord-walkthrough.vtt'), 'do not serve');
    stubGitHub(release(104, 'v4', 1004, 'https://dl.example/d'), { 'https://dl.example/d': 'WEBVTT d' });
    const media = await fresh();
    const cache = await cacheDir();
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(cache, 'release-104-asset-1004'));
    const served = await media.mediaFile('concord-walkthrough.vtt');
    expect(fs.readFileSync(served!, 'utf8')).toBe('WEBVTT d');
    expect(served!.startsWith(fs.realpathSync(cache) + path.sep)).toBe(true);
    // The link was replaced by a real folder, and nothing was written through it.
    expect(fs.lstatSync(path.join(cache, 'release-104-asset-1004')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, 'concord-walkthrough.vtt'), 'utf8')).toBe('do not serve');
  });

  it('fetches a replaced asset again, even under the same release', async () => {
    stubGitHub(release(105, 'v5', 1005, 'https://dl.example/e1'), { 'https://dl.example/e1': 'WEBVTT first' });
    const first = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    stubGitHub(release(105, 'v5', 1006, 'https://dl.example/e2'), { 'https://dl.example/e2': 'WEBVTT replaced' });
    const second = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    expect(fs.readFileSync(first!, 'utf8')).toBe('WEBVTT first');
    expect(fs.readFileSync(second!, 'utf8')).toBe('WEBVTT replaced');
  });

  it('keys releases without ids by a hash, still one folder per release', async () => {
    stubGitHub(release(undefined, 'release/9', undefined, 'https://dl.example/f'), { 'https://dl.example/f': 'WEBVTT f' });
    const first = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    stubGitHub(release(undefined, 'release_9', undefined, 'https://dl.example/g'), { 'https://dl.example/g': 'WEBVTT g' });
    const second = await (await fresh()).mediaFile('concord-walkthrough.vtt');
    expect(path.basename(path.dirname(first!))).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(path.dirname(second!)).not.toBe(path.dirname(first!));
    expect(fs.readFileSync(second!, 'utf8')).toBe('WEBVTT g');
    // The same release keys to the same folder next time.
    stubGitHub(release(undefined, 'release_9', undefined, 'https://dl.example/g'), {});
    expect(await (await fresh()).mediaFile('concord-walkthrough.vtt')).toBe(second);
  });
});

describe('which release', () => {
  it('uses the newest release that has the videos, skipping drafts and releases without them', async () => {
    stubGitHub(
      [
        { ...release(203, 'v3', 2003, 'https://dl.example/draft'), draft: true },
        { id: 202, tag_name: 'v2', html_url: 'https://github.com/x/y/releases/tag/v2', assets: [] }, // recording failed
        release(201, 'v1', 2001, 'https://dl.example/v1'),
      ],
      { 'https://dl.example/v1': 'WEBVTT v1' },
    );
    const media = await fresh();
    expect((await media.mediaIndex()).release?.tag).toBe('v1');
    expect(fs.readFileSync((await media.mediaFile('concord-walkthrough.vtt'))!, 'utf8')).toBe('WEBVTT v1');
  });

  it('skips releases with only some of the files, or files still uploading', async () => {
    const full = release(401, 'v1', 4001, 'https://dl.example/full');
    const captionsOnly = { ...release(402, 'v2', 4002, 'https://dl.example/x'), assets: full.assets.filter((a) => a.name.endsWith('.vtt')) };
    const uploading = { ...release(403, 'v3', 4003, 'https://dl.example/y'), assets: release(403, 'v3', 4003, 'https://dl.example/y').assets.map((a) => (a.name === 'concord-feedback.mp4' ? { ...a, state: 'open' } : a)) };
    stubGitHub([uploading, captionsOnly, full], {});
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v1');
  });

  it('reads every page of releases to find one with the videos', async () => {
    const empty = (n: number) => ({ id: 1000 + n, tag_name: `v0.0.${n}`, html_url: 'https://github.com/x/y', assets: [] });
    // It used to stop after 50 pages (5,000 releases).
    stubGitHub([...Array.from({ length: 5_050 }, (_, i) => empty(i)), release(501, 'v-old', 5001, 'https://dl.example/old')], {});
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v-old');
  });

  it('has no videos when no release has them', async () => {
    stubGitHub([{ id: 301, tag_name: 'v9', html_url: 'https://github.com/x/y/releases/tag/v9', assets: [] }], {});
    expect(await (await fresh()).mediaIndex()).toEqual({ release: null, files: [] });
  });
});

// On 2026-11-10 the repository went private: GitHub answered the anonymous lookup with "not found", the server took
// that as "no release has videos", and /welcome told testers the videos were being recorded, though nothing was.
describe('when GitHub can’t be read', () => {
  /** GitHub's API answers `status`; downloads under the `playing` prefixes still work, everything else is gone. */
  const failing = (status: number, playing: string[] = []) =>
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://api.github.com/')) return new Response('{"message":"Not Found"}', { status });
      return playing.some((p) => url.startsWith(p)) ? new Response('x', { status: 206 }) : new Response('', { status: 404 });
    });

  it('treats "not found" for the repository as a failed lookup, not as "no videos"', async () => {
    failing(404);
    await expect((await fresh()).mediaIndex()).rejects.toThrow(/HTTP 404/);
  });

  it('keeps serving the last complete set when GitHub fails, says not found, or stops listing one', async () => {
    stubGitHub(release(601, 'v6', 6001, 'https://dl.example/v6'), { 'https://dl.example/v6': 'WEBVTT v6' });
    const first = await fresh();
    const before = await first.mediaIndex();
    expect(before.release?.tag).toBe('v6');
    await first.mediaFile('concord-walkthrough.vtt');

    for (const status of [404, 403, 500]) {
      failing(status, ['https://dl.example/v6/']);
      const media = await fresh();
      expect(await media.mediaIndex()).toEqual(before);
      // The files still come from that release (its captions were downloaded while GitHub could be read).
      expect(fs.readFileSync((await media.mediaFile('concord-walkthrough.vtt'))!, 'utf8')).toBe('WEBVTT v6');
    }

    // A newer release whose recording failed, and the old one gone from the list: still the old set, while it plays.
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith('https://api.github.com/')
        ? Response.json([{ id: 602, tag_name: 'v7', html_url: 'https://github.com/x/y/releases/tag/v7', assets: [] }])
        : url.startsWith('https://dl.example/v6/')
          ? new Response('x', { status: 206 })
          : new Response('', { status: 404 }),
    );
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v6');

    // A newer complete set replaces the kept one.
    stubGitHub(release(603, 'v8', 6003, 'https://dl.example/v8'), {});
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v8');
    failing(404, ['https://dl.example/v8/']);
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v8');
  });

  // Sol review of #124: the kept set could point at a deleted release or a repository gone private, and the page
  // showed players that couldn't play. Now a kept set that no longer plays counts as nothing kept.
  it('doesn’t fall back to videos that no longer play', async () => {
    stubGitHub(release(611, 'v1', 6011, 'https://dl.example/gone'), {});
    await (await fresh()).mediaIndex();
    failing(404); // the API and the downloads alike
    await expect((await fresh()).mediaIndex()).rejects.toThrow(/no longer play/);
    // Nor when the release just isn't listed any more.
    vi.stubGlobal('fetch', async (url: string) => (url.startsWith('https://api.github.com/') ? Response.json([]) : new Response('', { status: 404 })));
    await expect((await fresh()).mediaIndex()).rejects.toThrow(/no longer play/);
  });

  // Sol review of #124 (round 2): the check that a kept set still plays went to GitHub even on the VM, which serves
  // the videos from its own disk, so an outage hid videos it had downloaded in full.
  it('on a server with the videos on its own disk, keeps serving them through an outage, downloads included', async () => {
    const urls = 'https://dl.example/disk';
    const files = Object.fromEntries(['', '/concord-walkthrough.mp4', '/concord-feedback.mp4', '/concord-feedback.vtt'].map((p) => [`${urls}${p}`, `data${p}`]));
    stubGitHub(release(631, 'v1', 6031, urls), files);
    const first = await fresh();
    const before = await first.mediaIndex();
    for (const f of ['concord-walkthrough.mp4', 'concord-walkthrough.vtt', 'concord-feedback.mp4', 'concord-feedback.vtt']) await first.mediaFile(f);

    failing(503); // the API and the downloads alike
    const media = await fresh();
    expect(await media.mediaIndex()).toEqual(before);
    expect(fs.readFileSync((await media.mediaFile('concord-feedback.mp4'))!, 'utf8')).toBe('data/concord-feedback.mp4');

    // On Vercel the browser is sent to GitHub, so there it counts as gone.
    process.env.CONCORD_MEDIA_REDIRECT = 'true';
    try {
      await expect((await fresh()).mediaIndex()).rejects.toThrow(/no longer play/);
    } finally {
      delete process.env.CONCORD_MEDIA_REDIRECT;
    }
  });

  // Sol review of #124: with the database refusing writes, a refresh that failed brought back the older set the
  // database still held, and the newer set's files (its clips, say) went missing from the same instance.
  it('never goes back to an older set after one it couldn’t save, in the same instance', async () => {
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      stubGitHub(release(621, 'v1', 6021, 'https://dl.example/old'), {});
      const media = await fresh();
      expect((await media.mediaIndex()).release?.tag).toBe('v1'); // saved
      db.failWrites = true;
      vi.setSystemTime(now + 11 * 60 * 1000);
      stubGitHub(release(622, 'v2', 6022, 'https://dl.example/new'), {});
      expect((await media.mediaIndex()).release?.tag).toBe('v2'); // couldn't be saved
      vi.setSystemTime(now + 22 * 60 * 1000);
      failing(500, ['https://dl.example/new/']);
      expect((await media.mediaIndex()).release?.tag).toBe('v2');
      process.env.CONCORD_MEDIA_REDIRECT = 'true';
      expect(await media.mediaRedirect('concord-feedback.mp4')).toBe('https://dl.example/new/concord-feedback.mp4');
    } finally {
      delete process.env.CONCORD_MEDIA_REDIRECT;
      vi.useRealTimers();
    }
  });

  it('doesn’t serve a set kept from another repository', async () => {
    stubGitHub(release(701, 'v1', 7001, 'https://dl.example/old-repo'), {});
    await (await fresh()).mediaIndex();
    process.env.MEDIA_REPO = 'someone/elsewhere';
    stubGitHub([], {});
    expect(await (await fresh()).mediaIndex()).toEqual({ release: null, files: [] });
    failing(404, ['https://dl.example/old-repo/']);
    await expect((await fresh()).mediaIndex()).rejects.toThrow(/someone\/elsewhere: HTTP 404/);
  });

  it('still shows the videos when the database can’t keep them', async () => {
    db.failWrites = true;
    stubGitHub(release(801, 'v1', 8001, 'https://dl.example/ro'), {});
    expect((await (await fresh()).mediaIndex()).release?.tag).toBe('v1');
  });
});

describe('media from a local folder', () => {
  it('lists and serves only regular files in the folder, never symlinks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')), 'secret.md');
    fs.writeFileSync(outside, 'do not serve');
    fs.writeFileSync(path.join(dir, 'concord-walkthrough.vtt'), 'WEBVTT');
    fs.symlinkSync(outside, path.join(dir, 'concord-walkthrough.transcript.md'));
    fs.mkdirSync(path.join(dir, 'concord-feedback.vtt'));
    process.env.MEDIA_DIR = dir;
    const media = await fresh();
    expect((await media.mediaIndex()).files.map((f) => f.name)).toEqual(['concord-walkthrough.vtt']);
    expect(await media.mediaFile('concord-walkthrough.vtt')).toBe(fs.realpathSync(path.join(dir, 'concord-walkthrough.vtt')));
    expect(await media.mediaFile('concord-walkthrough.transcript.md')).toBeUndefined();
    expect(await media.mediaFile('concord-feedback.vtt')).toBeUndefined();
    expect(await media.mediaFile('../secret.md')).toBeUndefined();
  });
});

describe('feature clips', () => {
  it('serves the clips, their captions and the playlist from a local folder, and nothing else that looks like them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
    for (const f of ['concord-clips.json', 'concord-clip-validate.mp4', 'concord-clip-validate.vtt', 'concord-clip-validate.transcript.md', 'concord-clip-vote-two.mp4', 'concord-clip-Bad.mp4', 'concord-clip-x.mov', 'concord-clips.json.bak', 'concord-clip-.mp4', 'notes.txt'])
      fs.writeFileSync(path.join(dir, f), 'x');
    process.env.MEDIA_DIR = dir;
    const media = await fresh();
    expect((await media.mediaIndex()).files.map((f) => f.name)).toEqual([
      'concord-clip-validate.mp4',
      'concord-clip-validate.transcript.md',
      'concord-clip-validate.vtt',
      'concord-clip-vote-two.mp4',
      'concord-clips.json',
    ]);
    expect(await media.mediaFile('concord-clips.json')).toBe(fs.realpathSync(path.join(dir, 'concord-clips.json')));
    for (const name of ['concord-clip-Bad.mp4', 'concord-clip-x.mov', 'concord-clips.json.bak', 'concord-clip-.mp4', 'concord-clip-../notes.txt', 'notes.txt']) expect(await media.mediaFile(name)).toBeUndefined();
    expect(media.MEDIA_TYPES['.json']).toMatch(/^application\/json/);
  });

  it('lists a release’s clips with its videos, but a release without clips still counts', async () => {
    const withClips = release(401, 'v2', 4001, 'https://dl.example/v2');
    withClips.assets.push(
      { id: 4100, name: 'concord-clips.json', size: 1, state: 'uploaded', browser_download_url: 'https://dl.example/v2/clips' },
      { id: 4101, name: 'concord-clip-validate.mp4', size: 1, state: 'uploaded', browser_download_url: 'https://dl.example/v2/c.mp4' },
      { id: 4102, name: 'concord-clip-vote.mp4', size: 1, state: 'open', browser_download_url: 'https://dl.example/v2/v.mp4' },
      { id: 4103, name: 'unrelated.zip', size: 1, state: 'uploaded', browser_download_url: 'https://dl.example/v2/u.zip' },
    );
    stubGitHub(withClips, { 'https://dl.example/v2/clips': '{"clips":[]}' });
    let media = await fresh();
    const names = (await media.mediaIndex()).files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['concord-clips.json', 'concord-clip-validate.mp4']));
    // Still uploading, or not ours: not listed.
    expect(names).not.toContain('concord-clip-vote.mp4');
    expect(names).not.toContain('unrelated.zip');
    expect(fs.readFileSync((await media.mediaFile('concord-clips.json'))!, 'utf8')).toBe('{"clips":[]}');

    // The newest release with both videos is used even when it has no clips.
    stubGitHub([release(402, 'v3', 4201, 'https://dl.example/v3'), withClips], {});
    media = await fresh();
    const index = await media.mediaIndex();
    expect(index.release?.tag).toBe('v3');
    expect(index.files.some((f) => f.name.startsWith('concord-clip'))).toBe(false);
  });
});

describe('on Vercel', () => {
  afterEach(() => {
    delete process.env.CONCORD_MEDIA_REDIRECT;
  });
  // A function's response is capped at a few MB and its disk is temporary, so serving a video through it
  // failed or filled the disk. Videos now redirect to GitHub; the small text files are still served here.
  it('sends the videos to GitHub and keeps serving captions from our origin, refusing large downloads', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'true';
    stubGitHub(release(9201, 'v-redirect', 92001, 'https://dl.example/r'), { 'https://dl.example/r': 'WEBVTT r' });
    const media = await fresh();
    expect(await media.mediaRedirect('concord-walkthrough.mp4')).toBe('https://dl.example/r/concord-walkthrough.mp4');
    expect(await media.mediaRedirect('concord-walkthrough.vtt')).toBeUndefined();
    expect(fs.readFileSync((await media.mediaFile('concord-walkthrough.vtt'))!, 'utf8')).toBe('WEBVTT r');
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith('https://api.github.com/')
        ? new Response(JSON.stringify([release(9202, 'v-big', 92002, 'https://dl.example/big')]), { status: 200 })
        : new Response('x', { status: 200, headers: { 'content-length': String(media.MAX_TEMP_DOWNLOAD + 1) } }),
    );
    const again = await fresh();
    await expect(again.mediaFile('concord-walkthrough.vtt')).rejects.toThrow(/too large/);
  });

  // Step 5 r1: only the declared Content-Length was checked, the body was streamed without counting, and nothing
  // was ever removed, so a missing or wrong length (or many releases) could fill a function's temporary disk.
  it('counts the bytes that arrive on a temporary disk, and removes the oldest files to stay under its total', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'true';
    const body = () => new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith('https://api.github.com/')
        ? new Response(JSON.stringify([release(9204, 'v-unsized', 92004, 'https://dl.example/unsized')]), { status: 200 })
        : new Response(body(), { status: 200 }),
    );
    const media = await fresh();
    await expect(media.mediaFile('concord-walkthrough.vtt')).rejects.toThrow(/too large/);
    const root = await cacheDir();
    const parts = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.part'));
    expect(parts).toEqual([]);
    // Old releases' files fill the cache: the oldest go first, so the total stays under the limit.
    const old = path.join(root, 'old-release');
    fs.mkdirSync(old, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const f = path.join(old, `f${i}.vtt`);
      fs.writeFileSync(f, Buffer.alloc(4 * 1024 * 1024));
      fs.utimesSync(f, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
    }
    stubGitHub(release(9205, 'v-small', 92005, 'https://dl.example/small'), { 'https://dl.example/small': 'WEBVTT small' });
    const again = await fresh();
    expect(fs.readFileSync((await again.mediaFile('concord-walkthrough.vtt'))!, 'utf8')).toBe('WEBVTT small');
    const sizes = fs.readdirSync(root, { recursive: true }).map((f) => fs.statSync(path.join(root, String(f)))).filter((st) => st.isFile());
    expect(sizes.reduce((n, st) => n + st.size, 0)).toBeLessThanOrEqual(media.MAX_TEMP_TOTAL);
    expect(fs.existsSync(path.join(old, 'f0.vtt'))).toBe(false);
    expect(fs.existsSync(path.join(old, 'f9.vtt'))).toBe(true);
    fs.rmSync(old, { recursive: true, force: true });
  });

  // Review r2 of step 5: downloads under way weren't counted, and each made room for one file only, so two at once
  // on top of a nearly full cache went over the total. Each now holds room for itself until it ends.
  it('keeps downloads under way within the total too', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'true';
    const root = await cacheDir();
    const old = path.join(root, 'old-release-2');
    fs.mkdirSync(old, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const f = path.join(old, `f${i}.vtt`);
      fs.writeFileSync(f, Buffer.alloc(4 * 1024 * 1024));
      fs.utimesSync(f, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
    }
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const almostFull = () =>
      new ReadableStream({
        async start(c) {
          c.enqueue(new Uint8Array(4 * 1024 * 1024 - 10));
          await gate;
          c.close();
        },
      });
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith('https://api.github.com/') ? new Response(JSON.stringify([release(9206, 'v-two', 92006, 'https://dl.example/two')]), { status: 200 }) : new Response(almostFull(), { status: 200 }),
    );
    const media = await fresh();
    const both = Promise.all([media.mediaFile('concord-walkthrough.vtt'), media.mediaFile('concord-feedback.vtt')]);
    await new Promise((r) => setTimeout(r, 50));
    open();
    await both;
    const total = fs.readdirSync(root, { recursive: true }).map((f) => fs.statSync(path.join(root, String(f)))).filter((st) => st.isFile()).reduce((n, st) => n + st.size, 0);
    expect(total).toBeLessThanOrEqual(media.MAX_TEMP_TOTAL);
    fs.rmSync(old, { recursive: true, force: true });
  });

  // Review r3 of step 5: a finished download gave its room back before it stopped being counted as under way, so
  // a download admitted in between neither counted its room nor could trim its file, and the total went over.
  it('holds a download’s room until it is no longer counted as under way', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'true';
    stubGitHub(release(9207, 'v-held', 92007, 'https://dl.example/held'), { 'https://dl.example/held': 'WEBVTT\n' });
    const media = await fresh();
    const rename = fs.renameSync.bind(fs);
    const seen: number[] = [];
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      seen.push(media.tempReserved());
      return rename(from, to);
    });
    try {
      await media.mediaFile('concord-walkthrough.vtt');
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([1]);
    expect(media.tempReserved()).toBe(0);
  });

  it('serves videos itself on the VM', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'false';
    stubGitHub(release(9203, 'v-vm', 92003, 'https://dl.example/v'), {});
    expect(await (await fresh()).mediaRedirect('concord-walkthrough.mp4')).toBeUndefined();
  });
});
