import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, no types
import { checkMedia } from '../../../scripts/check-media.mjs';

/**
 * scripts/check-media.mjs, the deploy check that the welcome page has its videos. On 2026-11-10 the page had lost
 * them for days (the server couldn't read the repository they were attached to) and nothing noticed.
 */

const MP4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]);
const complete = () => ({
  '/api/media/index.json': {
    release: { tag: 'v0.45.0', url: 'https://github.com/x/y/releases/tag/v0.45.0' },
    files: ['concord-walkthrough.mp4', 'concord-walkthrough.vtt', 'concord-feedback.mp4', 'concord-feedback.vtt', 'concord-clips.json', 'concord-clip-vote.mp4', 'concord-clip-vote.vtt'].map(
      (name) => ({ name, size: 1, url: `/api/media/${name}` }),
    ),
  } as Record<string, unknown>,
  '/api/media/concord-clips.json': { clips: [{ id: 'vote', file: 'concord-clip-vote', title: 'Vote' }] } as unknown,
});

/** A site serving `json` at its paths, MP4s and captions at the rest, and `override` where given. */
function site(json: Record<string, unknown>, override: Record<string, () => Response> = {}) {
  return async (url: URL) => {
    const p = url.pathname;
    if (override[p]) return override[p]();
    if (p in json) return Response.json(json[p]);
    if (p.endsWith('.mp4')) return new Response(MP4, { status: 206 });
    if (p.endsWith('.vtt')) return new Response('WEBVTT\n');
    return new Response('not found', { status: 404 });
  };
}

describe('the welcome-page video check', () => {
  it('passes a complete, playable set, and can require the release', async () => {
    const s = complete();
    expect(await checkMedia('https://site.example/', { fetch: site(s) })).toEqual({ problems: [], notes: ['videos from v0.45.0', '1 feature clips'] });
    expect((await checkMedia('https://site.example', { fetch: site(s), release: 'v0.46.0' })).problems).toEqual(['the videos are from v0.45.0, not v0.46.0']);
  });

  it('fails when the server has no videos to list, as on 2026-11-10', async () => {
    const { problems } = await checkMedia('https://site.example', { fetch: site({ '/api/media/index.json': { release: null, files: [] } }) });
    expect(problems).toContain('no release with a complete set of videos is being served');
    expect(problems).toContain('concord-walkthrough.mp4 is missing');
    expect(problems).toContain('the feature clips’ playlist (concord-clips.json) is missing');
    const down = await checkMedia('https://site.example', { fetch: site({ '/api/media/index.json': { release: null, files: [], unavailable: true } }) });
    expect(down.problems[0]).toMatch(/couldn’t look the videos up/);
  });

  it('fails when a listed video doesn’t play where the browser is sent: a 404, or a sign-in page', async () => {
    const s = complete();
    const { problems } = await checkMedia('https://site.example', {
      fetch: site(s, {
        '/api/media/concord-walkthrough.mp4': () => new Response('Not Found', { status: 404 }),
        '/api/media/concord-clip-vote.mp4': () => new Response('<!doctype html><title>Sign in to GitHub</title>'),
      }),
    });
    expect(problems).toEqual(['concord-walkthrough.mp4 doesn’t play: HTTP 404', expect.stringMatching(/^concord-clip-vote\.mp4 doesn’t look like an MP4/)]);
  });

  // Sol review of #124: a server may ignore Range and send the whole video with a 200; the check read it all into
  // memory, for every video at once. It reads the first bytes now and drops the rest.
  it('reads only the start of each video, even when the server sends all of it', async () => {
    let chunksSent = 0;
    let cancelled = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(chunksSent++ === 0 ? MP4 : new Uint8Array(1 << 20));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 200 },
      );
    const { problems } = await checkMedia('https://site.example', { fetch: site(complete(), { '/api/media/concord-walkthrough.mp4': endless }) });
    expect(problems).toEqual([]);
    expect(cancelled).toBe(1);
    expect(chunksSent).toBeLessThan(5);
  });

  // Sol review of #124: the page lists only clips with a title, so a playlist of untitled clips showed none, yet
  // passed the check.
  it('fails a playlist entry the page can’t show', async () => {
    const s = complete();
    s['/api/media/concord-clips.json'] = { clips: [{ id: 'vote', file: 'concord-clip-vote' }] };
    const { problems } = await checkMedia('https://site.example', { fetch: site(s) });
    expect(problems).toEqual(['the playlist entry "vote" can’t be shown: it needs a title and a concord-clip-… file', 'the feature clips’ playlist lists no clip the page can show']);
  });

  it('fails when the list can’t be read at all', async () => {
    const { problems } = await checkMedia('https://site.example', { fetch: site({}, { '/api/media/index.json': () => new Response('', { status: 502 }) }) });
    expect(problems).toEqual(["the video list (/api/media/index.json) can't be read: HTTP 502"]);
  });
});
