import type { OntologyProject, Release } from '@concord/shared';
import { config } from '../config.js';
import { HttpError, list } from '../db.js';
import { PUBLIC_BASE } from '../public/w3id.js';

/** Sample copies are published by Concord, not by the owner of the source namespace. */
export const projectVersionIRI = (project: Pick<OntologyProject, 'ontologyIRI' | 'slug' | 'sample'>, version: string) =>
  project.sample
    ? `${config.publicUrl}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version}`
    : `${project.ontologyIRI.replace(/[#/]$/, '')}/${version}`;

/** Historical identity belongs to the release, independent of today's PUBLIC_URL. */
export async function publishedVersionIRI(project: Pick<OntologyProject, 'id'>, version: string): Promise<string> {
  const release = (await list<Release>('releases', project.id)).find((r) => r.version === version && r.status === 'published');
  if (!release?.versionIRI) throw new HttpError(404, `Published version ${version} not found`);
  return release.versionIRI;
}
