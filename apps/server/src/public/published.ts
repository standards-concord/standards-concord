import type { Release } from '@concord/shared';
import { list } from '../db.js';

/** Published releases, newest first. A version can also have rejected or abandoned records: only these are public. */
export const publishedReleases = async (ontologyId: string) =>
  (await list<Release>('releases', ontologyId))
    .filter((r) => r.status === 'published')
    .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));

/** The one release record a version's public page shows: the steward approving that version reviews exactly this one. */
export const publishedRelease = async (ontologyId: string, version: string) => (await publishedReleases(ontologyId)).find((r) => r.version === version);
