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

test('says what Concord is for in a few lines, and leads into the walkthrough', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'Help us test Concord' })).toBeVisible();
  await expect(page.getByText(/early prototype for designing open data standards together/)).toBeVisible();

  // One paragraph on what Concord is for, and the note that matters before trying it. The aim cards, the numbered
  // steps (the walkthrough explains them) and the closing "Ready?" box were cut to keep the page short.
  const what = page.getByRole('region', { name: 'What Concord is for' });
  await expect(what.getByText(/Concord lets the whole community shape a standard/)).toBeVisible();
  await expect(what.getByRole('heading', { level: 3 })).toHaveCount(0);
  await expect(page.getByText(/don’t enter anything confidential/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'How the alpha works' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ready?' })).toHaveCount(0);
  await expect(page.getByText('Optional: the guided walkthrough covers the same ground.')).toBeVisible();
  await expect(page.getByText(/Recorded for release/)).toHaveCount(0);

  // One way into the walkthrough, at the top.
  await expect(page.getByRole('link', { name: 'Start the guided walkthrough' })).toHaveAttribute('href', '/alpha');
  await expect(page.getByRole('link', { name: 'Just leave feedback' })).toHaveAttribute('href', '/feedback');

  // The floating walkthrough guide stays out of the way here (it shows on other pages).
  await expect(page.getByRole('button', { name: /^Walkthrough/ })).toHaveCount(0);
  await page.goto('/feedback');
  await expect(page.getByRole('button', { name: /^Walkthrough/ })).toHaveCount(1);
});

test('plays the tour with captions, and says the feedback video isn’t ready yet', async ({ page }) => {
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
  await expect(feedback.getByTestId('feedback-pending')).toContainText('This video isn’t ready yet.');
  await expect(feedback.getByTestId('feedback-video')).toHaveCount(0);
});

// On 2026-11-10 the server couldn't read the releases (the repository had gone private), and the page told testers
// each video was "being recorded for the next release", though no recording was running. When the lookup fails it
// must say so, not promise a recording.
test('says the videos can’t be loaded, not that they’re being recorded, when the server can’t look them up', async ({ page }) => {
  await page.route('**/api/media/index.json', (route) => route.fulfill({ json: { release: null, files: [], unavailable: true } }));
  await page.goto('/welcome');
  for (const id of ['tour', 'feedback']) await expect(page.getByTestId(`${id}-pending`)).toContainText('This video can’t be loaded right now.');
  await expect(page.getByTestId('clips-pending')).toContainText('The feature clips can’t be loaded right now.');
  await expect(page.getByText(/being recorded/)).toHaveCount(0);
  // The way in that doesn't need the videos is still there.
  await expect(page.getByRole('link', { name: 'Start the guided walkthrough' })).toBeVisible();
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
  const playlist = (page: Page) => page.getByRole('region', { name: 'More features' });

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

  test('says the clips aren’t ready yet when the release has none', async ({ page }) => {
    await page.route('**/api/media/index.json', async (route) => {
      const res = await route.fetch();
      const index = await res.json();
      index.files = index.files.filter((f: { name: string }) => !f.name.startsWith('concord-clip'));
      await route.fulfill({ response: res, json: index });
    });
    await page.goto('/welcome');
    await expect(playlist(page).getByTestId('clips-pending')).toContainText('The feature clips aren’t ready yet.');
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
