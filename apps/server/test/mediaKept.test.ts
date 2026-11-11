import { beforeAll, expect, it } from 'vitest';
import { get, openDb, put } from '../src/db.js';
import { resetAll } from '../src/services/simulation.js';

/**
 * The welcome page's videos are listed from GitHub, and the last complete set is kept in the database in case GitHub
 * can't be read (services/media.ts; test/media.test.ts covers the lookup with a stand-in database). A demo reset
 * wipes the database, so it has to put that set back: it isn't demo data, and right after a reset is exactly when
 * testers are sent to /welcome.
 */

beforeAll(async () => {
  await openDb();
});

it('a demo reset keeps the list of videos kept in case GitHub can’t be read', async () => {
  const kept = {
    id: 'media-last-good',
    repo: 'standards-concord/standards-concord',
    index: { release: { tag: 'v0.32.0', url: 'https://github.com/x/y/releases/tag/v0.32.0' }, files: [{ name: 'concord-walkthrough.mp4', size: 1, url: '/api/media/concord-walkthrough.mp4' }] },
    assets: [['concord-walkthrough.mp4', { url: 'https://dl.example/tour.mp4', key: 'release-1-asset-2' }]],
    savedAt: '2026-11-10T18:00:00.000Z',
  };
  await put('kv', kept);
  await resetAll();
  expect(await get('kv', 'media-last-good')).toEqual(kept);
});
