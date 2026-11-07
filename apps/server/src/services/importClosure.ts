/**
 * Where an owl:imports IRI points, among the ontologies Concord hosts.
 *
 * An import names an ontology by its ontology IRI (the latest release, or the working draft if it has
 * never been released), by a version IRI (`<ontology IRI>/<version>`), or by its public page on this
 * site (`/def/<slug>` or `/def/<slug>/<version>`). Only what is public is loaded: a version waiting
 * for a steward's approval is reported as held, never read into another ontology's checks (validation
 * reports are public). Anything else is not hosted here, and is listed as not checked.
 */
import { resolveImportClosure, type ImportClosure, type ImportResolver, type OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { list } from '../db.js';
import { isHeld } from '../public/holds.js';
import { latestVersion } from '../public/routes.js';
import { PUBLIC_BASE } from '../public/w3id.js';
import { ontologyStore } from './ontologyStore.js';

const trim = (iri: string) => iri.replace(/[#/]+$/, '');

/** The hosted ontology and version an import IRI names, if any. `version` undefined: the IRI names no particular version. */
export function matchImport(iri: string, projects: OntologyProject[], publicUrl = config.publicUrl): { project: OntologyProject; version?: string } | undefined {
  const target = trim(iri);
  for (const project of projects) {
    for (const base of [trim(project.ontologyIRI), `${publicUrl}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`]) {
      if (!base) continue;
      if (target === base) return { project };
      if (target.startsWith(base + '/')) {
        const rest = decodeURIComponent(target.slice(base.length + 1));
        if (rest && !rest.includes('/')) return { project, version: rest };
      }
    }
  }
  return undefined;
}

export function hostedImportResolver(projects: OntologyProject[]): ImportResolver {
  return async (iri) => {
    const m = matchImport(iri, projects);
    if (!m) return null;
    const { project } = m;
    let version = m.version;
    if (version === undefined) version = (await latestVersion(project)) ?? 'draft';
    else if (version !== 'draft' && !(await ontologyStore.versions(project)).includes(version)) return null;
    if (await isHeld(project, version)) return { unresolved: 'held' };
    // A release never changes; the draft is named by its revision, read together with its graph so the
    // revision always names exactly what was loaded.
    if (version === 'draft') {
      const { graph, head } = await ontologyStore.workingAt(project);
      return { iri, graph, title: project.title, version, ontologyId: project.id, revision: `draft@${head}` };
    }
    const graph: OntologyGraph = await ontologyStore.at(project, version);
    return { iri, graph, title: project.title, version, ontologyId: project.id, revision: version };
  };
}

/** The import closure of `graph`, resolved against the ontologies Concord hosts. */
export async function hostedImportClosure(graph: OntologyGraph): Promise<ImportClosure> {
  if (graph.metadata().imports.length === 0) return { imported: [], unresolved: [], direct: [] };
  return resolveImportClosure(graph, hostedImportResolver(await list<OntologyProject>('ontologies')));
}

/** What the closure loaded, for cache keys: a report is reused only for exactly the same imports. */
export const closureFingerprint = (c: ImportClosure) =>
  [...c.imported.map((r) => `${r.ontologyId ?? r.iri}@${r.revision}`), ...c.unresolved.map((u) => `!${u.iri}:${u.reason}`)].join(',');
