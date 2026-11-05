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

const release = (id: number, tag: string, assetId: number, url: string) => ({
  id,
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  assets: [{ id: assetId, name: 'concord-walkthrough.vtt', size: 1, browser_download_url: url }],
});

function stubGitHub(latest: object, files: Record<string, string>) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(latest), { status: 200 });
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
