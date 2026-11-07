/**
 * The walkthrough videos (and the short feature clips) for the alpha landing page. They are recorded by CI for each
 * GitHub release (walkthrough/) and attached to it as release assets; this serves the
 * latest release's copies from our own origin, so the page can embed them with captions
 * (cross-origin caption tracks need CORS, which GitHub doesn't send) and seek within them.
 *
 *   MEDIA_REPO  owner/name of the repository whose releases hold the videos (the newest release that has them is used)
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

/** The two main videos with their captions and transcripts. */
export const MEDIA_FILES = [
  'concord-walkthrough.mp4',
  'concord-walkthrough.vtt',
  'concord-walkthrough.transcript.md',
  'concord-feedback.mp4',
  'concord-feedback.vtt',
  'concord-feedback.transcript.md',
] as const;

/**
 * The feature clips (walkthrough/clips.md): one recording cut into a file set per
 * feature, concord-clip-<id>.mp4, .vtt and .transcript.md, listed in this manifest for
 * the /welcome playlist. A release may have them or not; the main videos alone decide
 * which release is used.
 */
export const CLIP_MANIFEST = 'concord-clips.json';
const CLIP_FILE = /^concord-clip-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:mp4|vtt|transcript\.md)$/;

/** Every name we serve, and nothing else: the main videos' files, the clips' files and their manifest. */
export const isMediaName = (name: string) => (MEDIA_FILES as readonly string[]).includes(name) || name === CLIP_MANIFEST || CLIP_FILE.test(name);

export interface MediaIndex {
  /** The release the videos were recorded for; null when serving a local folder or none exists. */
  release: { tag: string; name?: string; publishedAt?: string; url: string } | null;
  files: { name: string; size: number; url: string }[];
}

const repo = () => process.env.MEDIA_REPO ?? 'standards-concord/standards-concord';
const localDir = () => (process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : undefined);
const cacheRoot = () => path.join(config.dataDir, 'media');
const INDEX_TTL_MS = 10 * 60 * 1000;

/** Where a release asset downloads from, and the cache folder that is its alone. */
interface Asset {
  url: string;
  key: string;
}

let cached: { at: number; index: Promise<MediaIndex>; assets: Map<string, Asset> } | undefined;

/** A GitHub release, as the releases API lists it. */
interface GitHubRelease {
  id?: number;
  tag_name: string;
  name?: string;
  published_at?: string;
  html_url: string;
  draft?: boolean;
  assets?: { id?: number; name: string; size: number; state?: string; browser_download_url: string }[];
}

/** The files a release must have, fully uploaded, for the page to use it: both videos and their captions. */
const REQUIRED = MEDIA_FILES.filter((f) => /\.(mp4|vtt)$/.test(f));

/** A release asset GitHub has finished receiving (one still uploading is in state "open"). */
const uploaded = (a: NonNullable<GitHubRelease['assets']>[number]) => isMediaName(a.name) && (a.state === undefined || a.state === 'uploaded');

const complete = (r: GitHubRelease) => !r.draft && REQUIRED.every((f) => (r.assets ?? []).some((a) => a.name === f && uploaded(a)));

/**
 * The newest published release with a complete set of videos, reading every page of
 * releases until one is found. A release whose recording failed, is still uploading, or
 * only has some of the files shouldn't hide the previous release's videos.
 */
async function fromGitHub(): Promise<{ index: MediaIndex; assets: Map<string, Asset> }> {
  let r: GitHubRelease | undefined;
  for (let page = 1; !r; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo()}/releases?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'concord-media' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
    const releases = (await res.json()) as GitHubRelease[];
    r = releases.find(complete);
    if (releases.length < 100) break;
  }
  if (!r) return { index: { release: null, files: [] }, assets: new Map() };
  const assets = new Map<string, Asset>();
  const files: MediaIndex['files'] = [];
  for (const a of r.assets ?? []) {
    if (!uploaded(a)) continue;
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
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isMediaName).sort();
  } catch {
    names = [];
  }
  const files = names.flatMap((f) => {
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

/**
 * On Vercel the videos aren't served through the function (a function's response is capped at a few MB, and its
 * disk is temporary): where they are on GitHub, for a redirect. Captions, transcripts and the clip list are small,
 * and still come from our origin (caption tracks need CORS, which GitHub doesn't send).
 */
export const redirectsVideos = () => !localDir() && (process.env.CONCORD_MEDIA_REDIRECT ? process.env.CONCORD_MEDIA_REDIRECT === 'true' : !!process.env.VERCEL);
/** The largest file downloaded into a temporary disk (when videos are redirected): text files only. */
export const MAX_TEMP_DOWNLOAD = 4 * 1024 * 1024;
/** The most the cache may hold on a temporary disk: older files are removed first to stay under it. */
export const MAX_TEMP_TOTAL = 32 * 1024 * 1024;

/** Downloads under way into the temporary disk, each holding MAX_TEMP_DOWNLOAD of the total until it ends. */
let reserved = 0;

/** Removes the cache's oldest files until it holds at most `budget` bytes (files being downloaded now are kept). */
function trimCache(budget: number) {
  const root = cacheRoot();
  const files: { file: string; size: number; at: number }[] = [];
  for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, folder.name), { withFileTypes: true })) {
      const file = path.join(root, folder.name, f.name);
      if (downloads.has(file.replace(/\.part$/, ''))) continue;
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (st) files.push({ file, size: st.isFile() ? st.size : 0, at: st.mtimeMs });
    }
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= budget) break;
    fs.rmSync(f.file, { force: true });
    total -= f.size;
  }
}

/** Where a release's video is on GitHub, when videos are redirected (see redirectsVideos). */
export async function mediaRedirect(name: string): Promise<string | undefined> {
  if (!redirectsVideos() || !isMediaName(name) || !name.endsWith('.mp4')) return undefined;
  const index = await mediaIndex();
  return index.release ? cached?.assets.get(name)?.url : undefined;
}

/** A local path for one of the media files, downloading it once per release if needed. */
export async function mediaFile(name: string): Promise<string | undefined> {
  if (!isMediaName(name)) return undefined;
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
      const small = redirectsVideos();
      // On a temporary disk, only small files, within a request's time.
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(small ? 20_000 : 10 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`Downloading ${name}: HTTP ${res.status}`);
      const tooLarge = () => new Error(`Downloading ${name}: too large to keep here`);
      if (small && Number(res.headers.get('content-length') ?? 0) > MAX_TEMP_DOWNLOAD) throw tooLarge();
      // The declared length can be missing or wrong: count what arrives, and make room first. Each download under
      // way holds room for its largest size, so downloads at once can't take the cache over its total together.
      if (small) {
        const room = MAX_TEMP_TOTAL - MAX_TEMP_DOWNLOAD * (reserved + 1);
        if (room < 0) throw new Error(`Downloading ${name}: too many downloads at once; try again shortly`);
        trimCache(room);
        reserved++;
      }
      const tmp = `${target}.part`;
      try {
        await pipeline(
          Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
          async function* (source: AsyncIterable<Buffer>) {
            let n = 0;
            for await (const chunk of source) {
              n += chunk.length;
              if (small && n > MAX_TEMP_DOWNLOAD) throw tooLarge();
              yield chunk;
            }
          },
          fs.createWriteStream(tmp),
        );
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      } finally {
        if (small) reserved--;
      }
      fs.renameSync(tmp, target);
      const ok = regularFileIn(folder, name, cacheRoot());
      if (!ok) throw new Error(`Downloading ${name}: the cached copy isn't a plain file`);
      return ok;
    })().finally(() => downloads.delete(target));
    downloads.set(target, job);
  }
  return job;
}

export const MEDIA_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
