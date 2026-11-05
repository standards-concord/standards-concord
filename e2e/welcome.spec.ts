import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, signIn, uniq } from './fixtures';

/**
 * The alpha landing page at /welcome: the link we send testers. It has to make sense on
 * its own, with nobody signed in, play the videos the latest release has (the tests serve
 * a stand-in folder: a short tour with captions and no feedback video), and lead into
 * the guided walkthrough.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('explains what Concord is and how the alpha works', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'Help us test Concord' })).toBeVisible();
  await expect(page.getByText(/early prototype for designing open data standards together/)).toBeVisible();

  const aims = page.getByRole('region', { name: 'What Concord is for' });
  for (const t of ['Rigorous by default', 'Shaped by the people who use them', 'Governance without endless meetings']) await expect(aims.getByRole('heading', { name: t })).toBeVisible();

  const how = page.getByRole('region', { name: 'How the alpha works' });
  await expect(how.getByRole('listitem')).toHaveCount(4);
  await expect(how.getByText(/don’t enter anything confidential/)).toBeVisible();

  // Both ways in, at the top and again at the bottom.
  const starts = page.getByRole('link', { name: 'Start the guided walkthrough' });
  await expect(starts).toHaveCount(2);
  for (const l of await starts.all()) await expect(l).toHaveAttribute('href', '/alpha');
  await expect(page.getByRole('link', { name: 'Just leave feedback' })).toHaveAttribute('href', '/feedback');

  // The floating walkthrough guide stays out of the way here (it shows on other pages).
  await expect(page.getByRole('button', { name: /^Walkthrough/ })).toHaveCount(0);
  await page.goto('/feedback');
  await expect(page.getByRole('button', { name: /^Walkthrough/ })).toHaveCount(1);
});

test('plays the tour with captions, and says the feedback video is on its way', async ({ page }) => {
  await page.goto('/welcome');
  const tour = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'A tour of Concord' }) });
  const video = tour.getByTestId('tour-video');
  await expect(video).toBeVisible();
  await expect(video.locator('source')).toHaveAttribute('src', '/api/media/concord-walkthrough.mp4');
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute('src', '/api/media/concord-walkthrough.vtt');

  // The browser can read it: its length shows once the metadata has loaded.
  await expect(tour.getByText('2 seconds, with captions')).toBeVisible();
  const cues = await video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<string[]>((resolve) => {
        const track = v.textTracks[0];
        track.mode = 'hidden';
        const read = () => (track.cues?.length ? resolve([...track.cues].map((c) => (c as VTTCue).text)) : setTimeout(read, 100));
        read();
      }),
  );
  expect(cues).toEqual(['Hi, and welcome to Concord.']);

  const transcript = tour.getByRole('link', { name: 'Read the transcript' });
  await expect(transcript).toHaveAttribute('href', '/api/media/concord-walkthrough.transcript.md');

  const feedback = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'How to take part and give feedback' }) });
  await expect(feedback.getByTestId('feedback-pending')).toContainText('being recorded for the next release');
  await expect(feedback.getByTestId('feedback-video')).toHaveCount(0);
});

test('the start button opens the guided walkthrough', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('link', { name: 'Start the guided walkthrough' }).first().click();
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(page.getByRole('heading', { name: 'Guided walkthrough' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '1. Welcome' })).toBeVisible();
});

test('the sign-in page points alpha testers here', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Alpha tester? Start here' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help us test Concord' })).toBeVisible();
});

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'Help us test Concord' })).toBeVisible();
  await expect(page.getByTestId('tour-video')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe('feature clips playlist', () => {
  const playlist = (page: Page) => page.getByRole('region', { name: 'More features, one at a time' });

  test('lists the clips the release has in a drop-down, and plays the one picked', async ({ page }) => {
    await page.goto('/welcome');
    const section = playlist(page);
    const picker = section.getByRole('combobox', { name: 'Choose a feature' });
    // "missing" is in the playlist file but has no video in this release, so it isn't offered.
    await expect(picker.getByRole('option')).toHaveText(['1. Validate your data (0:02)', '2. Voting on a breaking change (0:02)']);
    await expect(picker).toHaveValue('validate');

    const video = section.getByTestId('clip-video');
    await expect(video.locator('source')).toHaveAttribute('src', '/api/media/concord-clip-validate.mp4');
    await expect(video.locator('track[kind="captions"]')).toHaveAttribute('src', '/api/media/concord-clip-validate.vtt');
    await expect(section.getByRole('heading', { name: 'Validate your data' })).toBeVisible();
    await expect(section.getByText('Validate data checks a whole file against any release of the standard.')).toBeVisible();
    await expect(section.getByRole('link', { name: 'Read the transcript' })).toHaveAttribute('href', '/api/media/concord-clip-validate.transcript.md');
    // The browser can read the clip.
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);

    await picker.selectOption({ label: '2. Voting on a breaking change (0:02)' });
    await expect(video.locator('source')).toHaveAttribute('src', '/api/media/concord-clip-vote.mp4');
    await expect(section.getByRole('heading', { name: 'Voting on a breaking change' })).toBeVisible();
    // This clip has no captions or transcript in the release: nothing points at missing files.
    await expect(video.locator('track')).toHaveCount(0);
    await expect(section.getByRole('link', { name: 'Read the transcript' })).toHaveCount(0);
    // The last clip has no "next".
    await expect(section.getByRole('button', { name: /^Next:/ })).toHaveCount(0);
    // The address names the clip, so it can be shared.
    await expect(page).toHaveURL(/\/welcome#clip-vote$/);
  });

  test('plays the next clip when one ends, or on request', async ({ page }) => {
    await page.goto('/welcome');
    const section = playlist(page);
    const video = section.getByTestId('clip-video');
    await expect(video.locator('source')).toHaveAttribute('src', '/api/media/concord-clip-validate.mp4');
    await video.evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended')));
    await expect(section.getByRole('combobox', { name: 'Choose a feature' })).toHaveValue('vote');
    await expect(video.locator('source')).toHaveAttribute('src', '/api/media/concord-clip-vote.mp4');
    await expect(video).toHaveJSProperty('autoplay', true);

    await page.goto('/welcome#clip-validate');
    await section.getByRole('button', { name: 'Next: Voting on a breaking change' }).click();
    await expect(section.getByRole('combobox', { name: 'Choose a feature' })).toHaveValue('vote');
  });

  test('a link to one clip opens it', async ({ page }) => {
    await page.goto('/welcome#clip-vote');
    await expect(playlist(page).getByRole('combobox', { name: 'Choose a feature' })).toHaveValue('vote');
    await expect(playlist(page)).toBeInViewport();
  });

  test('signed-in testers see the same playlist', async ({ page }) => {
    await signIn(page, { name: `Clip watcher ${uniq()}`, role: 'contributor' });
    await page.goto('/welcome');
    await expect(playlist(page).getByRole('combobox', { name: 'Choose a feature' }).getByRole('option')).toHaveCount(2);
  });

  test('says the clips are on their way when the release has none', async ({ page }) => {
    await page.route('**/api/media/index.json', async (route) => {
      const res = await route.fetch();
      const index = await res.json();
      index.files = index.files.filter((f: { name: string }) => !f.name.startsWith('concord-clip'));
      await route.fulfill({ response: res, json: index });
    });
    await page.goto('/welcome');
    await expect(playlist(page).getByTestId('clips-pending')).toContainText('being recorded for the next release');
    await expect(playlist(page).getByRole('combobox')).toHaveCount(0);
  });
});

test.describe('media API', () => {
  test('lists and serves only the walkthrough files', async ({ request }) => {
    const index = await (await request.get('/api/media/index.json')).json();
    expect(index.release).toBeNull();
    expect(index.files.map((f: { name: string }) => f.name).sort()).toEqual([
      'concord-clip-validate.mp4',
      'concord-clip-validate.transcript.md',
      'concord-clip-validate.vtt',
      'concord-clip-vote.mp4',
      'concord-clips.json',
      'concord-walkthrough.mp4',
      'concord-walkthrough.transcript.md',
      'concord-walkthrough.vtt',
    ]);
    const clips = await request.get('/api/media/concord-clips.json');
    expect(clips.headers()['content-type']).toMatch(/^application\/json/);
    expect((await clips.json()).clips.map((c: { id: string }) => c.id)).toEqual(['validate', 'missing', 'vote']);
    expect((await request.get('/api/media/concord-clip-missing.mp4')).status()).toBe(404);

    const vtt = await request.get('/api/media/concord-walkthrough.vtt');
    expect(vtt.status()).toBe(200);
    expect(vtt.headers()['content-type']).toContain('text/vtt');

    const md = await request.get('/api/media/concord-walkthrough.transcript.md');
    expect(md.headers()['content-type']).toContain('text/markdown');

    // Seeking needs range requests.
    const part = await request.get('/api/media/concord-walkthrough.mp4', { headers: { range: 'bytes=0-99' } });
    expect(part.status()).toBe(206);
    expect((await part.body()).length).toBe(100);

    // A file the release doesn't have, a name that isn't a media file, and a path escape.
    expect((await request.get('/api/media/concord-feedback.mp4')).status()).toBe(404);
    expect((await request.get('/api/media/README.md')).status()).toBe(404);
    expect((await request.get('/api/media/..%2F..%2Fpackage.json')).status()).toBe(404);
  });

  // A symlink with an allowed name used to be served, so it could hand any readable file
  // on the server to anyone. Only regular files in the folder are served now.
  test('never serves a symlink, even with an allowed name', async ({ request }) => {
    const link = path.join(import.meta.dirname, 'fixtures', 'media', 'concord-feedback.transcript.md');
    fs.symlinkSync(path.join(import.meta.dirname, '..', 'package.json'), link);
    try {
      expect((await request.get('/api/media/concord-feedback.transcript.md')).status()).toBe(404);
      const index = await (await request.get('/api/media/index.json')).json();
      expect(index.files.map((f: { name: string }) => f.name)).not.toContain('concord-feedback.transcript.md');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});
