/**
 * Semantic versioning of ontology releases (OWL 2 versioning vocabulary).
 */
import type { ChangeLevel } from './types.js';
import { NS } from './ns.js';
import { OntologyGraph } from './graph.js';
import { setMetadata } from './changes.js';
import { literal, nn } from './rdf.js';

/** Bumps a semver string ("1.2.3", "v1.2", "0.1.0-rc1") by level; pre-release suffixes are dropped. */
export function bumpVersion(version: string, level: ChangeLevel): string {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) throw new Error(`not a semantic version: "${version}"`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  if (level === 'major') [maj, min, pat] = [maj + 1, 0, 0];
  else if (level === 'minor') [min, pat] = [min + 1, 0];
  else pat += 1;
  return `${maj}.${min}.${pat}`;
}

export interface StampOptions {
  version: string;
  versionIRIBase?: string;
  priorVersionIRI?: string;
  level: ChangeLevel;
  date: string;
  backwardCompatible: boolean;
}

/**
 * Returns a copy of the graph stamped as a release: owl:versionIRI, owl:versionInfo,
 * owl:priorVersion and owl:backwardCompatibleWith / owl:incompatibleWith (the OWL
 * annotations get their meaning from the platform's classification), plus
 * dcterms:modified and dcterms:issued. A `major` level always yields owl:incompatibleWith.
 */
export function stampRelease(graph: OntologyGraph, opts: StampOptions): OntologyGraph {
  const g = graph.clone();
  const iri = g.ontologyIRI;
  if (!iri) throw new Error('ontology has no owl:Ontology header');
  const base = opts.versionIRIBase ?? iri;
  const versionIRI = /[#/]$/.test(base) ? `${base}${opts.version}` : `${base}/${opts.version}`;
  const current = g.metadata().versionIRI;
  // A major release is never backward compatible, whatever the caller says.
  const compatible = opts.backwardCompatible && opts.level !== 'major';
  const prior = opts.priorVersionIRI ?? (current && current !== versionIRI ? current : undefined);
  setMetadata(g, {
    versionIRI,
    versionInfo: opts.version,
    modified: opts.date,
    issued: opts.date,
    ...(prior
      ? {
          priorVersion: prior,
          backwardCompatibleWith: compatible ? [prior] : [],
          incompatibleWith: compatible ? [] : [prior],
        }
      : {}),
  });
  // Keep the citation's version in step, if it mentions one.
  const cite = g.literalOf(iri, NS.dcterms + 'bibliographicCitation');
  if (cite && /Version \d+(\.\d+)*/.test(cite)) {
    const s = g.store;
    for (const q of s.getQuads(null, null, null, null)) {
      if (q.subject.value === iri && q.predicate.value === NS.dcterms + 'bibliographicCitation') s.removeQuad(q);
    }
    s.addQuad(nn(iri), nn(NS.dcterms + 'bibliographicCitation'), literal(cite.replace(/Version \d+(\.\d+)*/, `Version ${opts.version}`)));
  }
  return g;
}
