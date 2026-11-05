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
import { createHash } from 'node:crypto';
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

/** Where a release asset downloads from, and the cache folder that is its alone. */
interface Asset {
  url: string;
  key: string;
}

let cached: { at: number; index: Promise<MediaIndex>; assets: Map<string, Asset> } | undefined;

const isMediaFile = (name: string): name is (typeof MEDIA_FILES)[number] => (MEDIA_FILES as readonly string[]).includes(name);

async function fromGitHub(): Promise<{ index: MediaIndex; assets: Map<string, Asset> }> {
  const res = await fetch(`https://api.github.com/repos/${repo()}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'concord-media' },
    signal: AbortSignal.timeout(8000),
  });
  // 404: the repository has no published release yet.
  if (res.status === 404) return { index: { release: null, files: [] }, assets: new Map() };
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const r = (await res.json()) as { id?: number; tag_name: string; name?: string; published_at?: string; html_url: string; assets: { id?: number; name: string; size: number; browser_download_url: string }[] };
  const assets = new Map<string, Asset>();
  const files: MediaIndex['files'] = [];
  for (const a of r.assets ?? []) {
    if (!isMediaFile(a.name)) continue;
    assets.set(a.name, { url: a.browser_download_url, key: cacheKey(r, a) });
    files.push({ name: a.name, size: a.size, url: `/api/media/${a.name}` });
  }
  return { index: { release: { tag: r.tag_name, name: r.name || undefined, publishedAt: r.published_at, url: r.html_url }, files }, assets };
}

/**
 * A cache folder name for one release asset that no other asset can share: GitHub's own
 * ids for the release and the asset, or a hash of everything that identifies it.
 * (Tags can't be used: "release/1" and "release_1" would end up in the same folder.)
 */
function cacheKey(r: { id?: number; tag_name: string }, a: { id?: number; name: string; browser_download_url: string }) {
  if (Number.isSafeInteger(r.id) && Number.isSafeInteger(a.id)) return `release-${r.id}-asset-${a.id}`;
  return `sha256-${createHash('sha256').update(JSON.stringify([repo(), r.tag_name, a.name, a.browser_download_url])).digest('hex')}`;
}

/**
 * The file `name` in `dir`, only if it is a regular file that really is there: never a
 * symlink, a folder, or anything that resolves outside `root`, the folder we trust (the
 * media folder itself, or the cache root). Its resolved path must be exactly where it
 * would be with no links at all, so a linked folder on the way doesn't pass either.
 */
function regularFileIn(dir: string, name: string, root = dir): string | undefined {
  const p = path.join(dir, name);
  try {
    if (!fs.lstatSync(p).isFile()) return undefined;
    const real = fs.realpathSync(p);
    const expected = path.join(fs.realpathSync(root), path.relative(root, p));
    return real === expected ? real : undefined;
  } catch {
    return undefined;
  }
}

function fromFolder(dir: string): MediaIndex {
  const files = MEDIA_FILES.flatMap((f) => {
    const p = regularFileIn(dir, f);
    return p ? [{ name: f, size: fs.statSync(p).size, url: `/api/media/${f}` }] : [];
  });
  return { release: null, files };
}

/** Which videos exist, and for which release. Cached for ten minutes. */
export async function mediaIndex(): Promise<MediaIndex> {
  const dir = localDir();
  if (dir) return fromFolder(dir);
  if (!cached || Date.now() - cached.at > INDEX_TTL_MS) {
    const assets = new Map<string, Asset>();
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
  if (dir) return regularFileIn(dir, name);
  const index = await mediaIndex();
  const asset = cached?.assets.get(name);
  if (!index.release || !asset) return undefined;
  const folder = path.join(cacheRoot(), asset.key);
  const target = path.join(folder, name);
  const have = regularFileIn(folder, name, cacheRoot());
  if (have) return have;
  const url = asset.url;
  let job = downloads.get(target);
  if (!job) {
    job = (async () => {
      // A link (or file) where the asset's folder belongs is removed, never written through.
      const st = fs.lstatSync(folder, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) fs.unlinkSync(folder);
      fs.mkdirSync(folder, { recursive: true });
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`Downloading ${name}: HTTP ${res.status}`);
      const tmp = `${target}.part`;
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
      fs.renameSync(tmp, target);
      const ok = regularFileIn(folder, name, cacheRoot());
      if (!ok) throw new Error(`Downloading ${name}: the cached copy isn't a plain file`);
      return ok;
    })().finally(() => downloads.delete(target));
    downloads.set(target, job);
  }
  return job;
}

export const MEDIA_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
