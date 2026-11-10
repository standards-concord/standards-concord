#!/usr/bin/env node
/**
 * Checks that a Concord site's welcome page has its videos: the tour, the feedback video and the feature clips, each
 * listed, with captions, and playable from where the page sends the browser (following redirects, as a browser does).
 *
 *   node scripts/check-media.mjs https://standards-concord.vercel.app
 *   node scripts/check-media.mjs https://standards-concord.vercel.app --release v0.45.0   # and recorded for this release
 *
 * Exits 1 with the reasons if anything is missing, so a deploy (and deploy/smoke.sh) can stop on it. The page must
 * never be without its videos: on 2026-11-10 it was, for days, because the server could no longer read the
 * repository the videos were attached to, and nothing noticed.
 */

const MAIN = ['concord-walkthrough', 'concord-feedback'];
const TIMEOUT_MS = 30_000;

export async function checkMedia(base, { release, fetch: get = fetch } = {}) {
  base = base.replace(/\/+$/, '');
  const problems = [];
  const notes = [];
  const fetchOk = async (url, init) => {
    const res = await get(new URL(url, base), { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };

  let index;
  try {
    index = await (await fetchOk('/api/media/index.json')).json();
  } catch (err) {
    return { problems: [`the video list (/api/media/index.json) can't be read: ${err.message}`], notes };
  }
  if (index.unavailable) problems.push('the server couldn’t look the videos up and has none kept from before');
  if (!index.release) problems.push('no release with a complete set of videos is being served');
  else {
    notes.push(`videos from ${index.release.tag}`);
    if (release && index.release.tag !== release) problems.push(`the videos are from ${index.release.tag}, not ${release}`);
  }
  const files = new Map((index.files ?? []).map((f) => [f.name, f.url]));

  // An MP4 starts with an `ftyp` box: the first bytes are enough to know the browser is given a real video.
  const playable = async (name) => {
    const url = files.get(name);
    if (!url) return void problems.push(`${name} is missing`);
    try {
      const res = await fetchOk(url, { headers: { range: 'bytes=0-63' } });
      const head = new Uint8Array(await res.arrayBuffer()).slice(0, 12);
      if (new TextDecoder().decode(head.slice(4, 8)) !== 'ftyp') problems.push(`${name} doesn’t look like an MP4 (from ${res.url})`);
    } catch (err) {
      problems.push(`${name} doesn’t play: ${err.message}`);
    }
  };
  const captions = async (name) => {
    const url = files.get(name);
    if (!url) return void problems.push(`${name} is missing`);
    try {
      const text = await (await fetchOk(url)).text();
      if (!text.startsWith('WEBVTT')) problems.push(`${name} isn’t a captions file`);
    } catch (err) {
      problems.push(`${name} can’t be read: ${err.message}`);
    }
  };

  const jobs = [];
  for (const stem of MAIN) jobs.push(playable(`${stem}.mp4`), captions(`${stem}.vtt`));
  if (files.has('concord-clips.json')) {
    try {
      const manifest = await (await fetchOk(files.get('concord-clips.json'))).json();
      const clips = manifest.clips ?? [];
      if (!clips.length) problems.push('the feature clips’ playlist lists no clips');
      for (const c of clips) jobs.push(playable(`${c.file}.mp4`), captions(`${c.file}.vtt`));
      notes.push(`${clips.length} feature clips`);
    } catch (err) {
      problems.push(`the feature clips’ playlist can’t be read: ${err.message}`);
    }
  } else problems.push('the feature clips’ playlist (concord-clips.json) is missing');
  await Promise.all(jobs);
  return { problems, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--release');
  const release = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const [base] = args;
  if (!base || (at >= 0 && !release)) {
    console.error('Usage: node scripts/check-media.mjs <site url> [--release vX.Y.Z]');
    process.exit(2);
  }
  const { problems, notes } = await checkMedia(base, { release });
  if (problems.length) {
    console.error(`FAIL welcome-page videos at ${base}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`ok   welcome-page videos at ${base} (${notes.join(', ')})`);
}
