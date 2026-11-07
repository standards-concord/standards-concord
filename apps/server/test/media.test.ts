import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The walkthrough videos served at /api/media/. The browser tests (e2e/welcome.spec.ts)
 * use a local folder; the release cache needs GitHub, so it is tested here with a stub.
 */

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

  it('serves videos itself on the VM', async () => {
    process.env.CONCORD_MEDIA_REDIRECT = 'false';
    stubGitHub(release(9203, 'v-vm', 92003, 'https://dl.example/v'), {});
    expect(await (await fresh()).mediaRedirect('concord-walkthrough.mp4')).toBeUndefined();
  });
});
