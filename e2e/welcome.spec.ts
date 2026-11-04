import { test, expect } from './fixtures';

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

test.describe('media API', () => {
  test('lists and serves only the walkthrough files', async ({ request }) => {
    const index = await (await request.get('/api/media/index.json')).json();
    expect(index.release).toBeNull();
    expect(index.files.map((f: { name: string }) => f.name).sort()).toEqual(['concord-walkthrough.mp4', 'concord-walkthrough.transcript.md', 'concord-walkthrough.vtt']);

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
});
