/**
 * The walkthrough videos for the alpha landing page. They are recorded by CI for each
 * GitHub release (walkthrough/) and attached to it as release assets; this serves the
 * latest release's copies from our own origin, so the page can embed them with captions
 * (cross-origin caption tracks need CORS, which GitHub doesn't send) and seek within them.
 *
 *   MEDIA_REPO  owner/name of the repository whose latest release holds the videos
 *   MEDIA_DIR   serve files from this local folder instead (tests, or a recording you just made)
 *
 * Downloads are cached in the data directory per release tag, so a file is fetched from
 * GitHub once per release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

/** The only files we serve: the two videos with their captions and transcripts. */
export const MEDIA_FILES = [
  'concord-walkthrough.mp4',
  'concord-walkthrough.vtt',
  'concord-walkthrough.transcript.md',
  'concord-feedback.mp4',
  'concord-feedback.vtt',
  'concord-feedback.transcript.md',
] as const;

export interface MediaIndex {
  /** The release the videos were recorded for; null when serving a local folder or none exists. */
  release: { tag: string; name?: string; publishedAt?: string; url: string } | null;
  files: { name: string; size: number; url: string }[];
}

const repo = () => process.env.MEDIA_REPO ?? 'jeswr/standards-concord';
const localDir = () => (process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : undefined);
const cacheRoot = () => path.join(config.dataDir, 'media');
const INDEX_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; index: Promise<MediaIndex>; assets: Map<string, string> } | undefined;

const isMediaFile = (name: string): name is (typeof MEDIA_FILES)[number] => (MEDIA_FILES as readonly string[]).includes(name);

async function fromGitHub(): Promise<{ index: MediaIndex; assets: Map<string, string> }> {
  const res = await fetch(`https://api.github.com/repos/${repo()}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'concord-media' },
    signal: AbortSignal.timeout(8000),
  });
  // 404: the repository has no published release yet.
  if (res.status === 404) return { index: { release: null, files: [] }, assets: new Map() };
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const r = (await res.json()) as { tag_name: string; name?: string; published_at?: string; html_url: string; assets: { name: string; size: number; browser_download_url: string }[] };
  const assets = new Map<string, string>();
  const files: MediaIndex['files'] = [];
  for (const a of r.assets ?? []) {
    if (!isMediaFile(a.name)) continue;
    assets.set(a.name, a.browser_download_url);
    files.push({ name: a.name, size: a.size, url: `/api/media/${a.name}` });
  }
  return { index: { release: { tag: r.tag_name, name: r.name || undefined, publishedAt: r.published_at, url: r.html_url }, files }, assets };
}

function fromFolder(dir: string): MediaIndex {
  const files = MEDIA_FILES.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, url: `/api/media/${f}` }));
  return { release: null, files };
}

/** Which videos exist, and for which release. Cached for ten minutes. */
export async function mediaIndex(): Promise<MediaIndex> {
  const dir = localDir();
  if (dir) return fromFolder(dir);
  if (!cached || Date.now() - cached.at > INDEX_TTL_MS) {
    const assets = new Map<string, string>();
    const index = fromGitHub().then((r) => {
      for (const [k, v] of r.assets) assets.set(k, v);
      return r.index;
    });
    cached = { at: Date.now(), index, assets };
    // A failed lookup is retried on the next request rather than cached for ten minutes.
    index.catch(() => {
      if (cached?.index === index) cached = undefined;
    });
  }
  return cached.index;
}

const downloads = new Map<string, Promise<string>>();

/** A local path for one of the media files, downloading it once per release if needed. */
export async function mediaFile(name: string): Promise<string | undefined> {
  if (!isMediaFile(name)) return undefined;
  const dir = localDir();
  if (dir) {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : undefined;
  }
  const index = await mediaIndex();
  const url = cached?.assets.get(name);
  if (!index.release || !url) return undefined;
  const target = path.join(cacheRoot(), index.release.tag.replace(/[^\w.-]/g, '_'), name);
  if (fs.existsSync(target)) return target;
  let job = downloads.get(target);
  if (!job) {
    job = (async () => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`Downloading ${name}: HTTP ${res.status}`);
      const tmp = `${target}.part`;
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
      fs.renameSync(tmp, target);
      return target;
    })().finally(() => downloads.delete(target));
    downloads.set(target, job);
  }
  return job;
}

export const MEDIA_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
