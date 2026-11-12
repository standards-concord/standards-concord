import type { OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { PUBLIC_BASE } from '../public/w3id.js';

/** Sample copies are published by Concord, not by the owner of the source namespace. */
export const projectVersionIRI = (project: Pick<OntologyProject, 'ontologyIRI' | 'slug' | 'sample'>, version: string) =>
  project.sample
    ? `${config.publicUrl}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version}`
    : `${project.ontologyIRI.replace(/[#/]$/, '')}/${version}`;
