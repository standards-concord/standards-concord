import type { OntologyProject, Release } from '@concord/shared';
import { list } from '../db.js';
import { ontologyStore } from '../services/ontologyStore.js';

/** Published releases, newest first. A version can also have rejected or abandoned records: only these are public. */
export const publishedReleases = async (ontologyId: string) =>
  (await list<Release>('releases', ontologyId))
    .filter((r) => r.status === 'published')
    .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));

/** The one release record a version's public page shows: the steward approving that version reviews exactly this one. */
export const publishedRelease = async (ontologyId: string, version: string) => (await publishedReleases(ontologyId)).find((r) => r.version === version);

/** The latest released version, if any, that exists in the repository. */
export async function latestVersion(project: OntologyProject): Promise<string | undefined> {
  const versions = await ontologyStore.versions(project);
  if (project.currentVersion !== '0.0.0' && versions.includes(project.currentVersion)) return project.currentVersion;
  return (await publishedReleases(project.id)).find((r) => versions.includes(r.version))?.version;
}
