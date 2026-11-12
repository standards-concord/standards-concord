/**
 * A federation release: a snapshot that pins every ontology in a federation, members and everything
 * they import, to a released version and its RDFC-1.0 content hash, together with the hash of the
 * SHACL shapes derived from the members' OWL. It is published as an OWL ontology; the pins use the SPDX
 * checksum vocabulary, and owl:priorVersion links releases into a chain.
 *
 * The manifest owl:imports one thing: the release's frozen closure, every pinned graph merged as it was
 * checked, with no owl:imports of its own. Importing the members' version IRIs instead would not freeze
 * anything: a member that imports an ontology without naming a version would get whatever that ontology
 * is when the tool loads it. So any OWL tool that imports the manifest loads exactly the pinned content,
 * and the pins say what it is made of (dcterms:hasPart for members, dcterms:requires for their imports).
 */
import { DataFactory, Store, type Quad_Object, type Quad_Subject } from 'n3';
import { OntologyGraph } from './graph.js';
import { NS, RDF_TYPE } from './ns.js';
import { bumpVersion } from './version.js';
import type { ChangeLevel, FederationPin } from './types.js';

const SPDX = 'http://spdx.org/rdf/terms#';
const { namedNode: nn, literal, blankNode, quad } = DataFactory;

export type { FederationPin } from './types.js';

export interface ManifestInput {
  iri: string;
  version: string;
  title: string;
  description?: string;
  issued: string;
  previousVersionIRI?: string;
  pins: FederationPin[];
  /** Where the derived shapes are published, and their hash. */
  shapes: { iri: string; hash: string };
  /** Where the frozen closure (every pinned graph, merged) is published, and its hash. */
  closure: { iri: string; hash: string };
}

export const fedVersionIRI = (iri: string, version: string) => `${iri.replace(/[#/]+$/, '')}/${version}`;

/** The release's manifest as an OWL ontology. */
export function manifestGraph(m: ManifestInput): OntologyGraph {
  const s = new Store();
  const fed = nn(m.iri);
  const add = (subj: Quad_Subject, p: string, o: Quad_Object) => s.addQuad(quad(subj, nn(p), o));
  const checksum = (subject: string, hash: string) => {
    const c = blankNode();
    add(nn(subject), SPDX + 'checksum', c);
    add(c, RDF_TYPE, nn(SPDX + 'Checksum'));
    add(c, SPDX + 'algorithm', nn(SPDX + 'checksumAlgorithm_sha256'));
    add(c, SPDX + 'checksumValue', literal(hash.replace(/^sha256:/, '')));
  };
  add(fed, RDF_TYPE, nn(NS.owl + 'Ontology'));
  add(fed, NS.owl + 'versionIRI', nn(fedVersionIRI(m.iri, m.version)));
  add(fed, NS.owl + 'versionInfo', literal(m.version));
  add(fed, NS.dcterms + 'title', literal(m.title, 'en'));
  if (m.description) add(fed, NS.dcterms + 'description', literal(m.description, 'en'));
  add(fed, NS.dcterms + 'issued', literal(m.issued.slice(0, 10), nn(NS.xsd + 'date')));
  if (m.previousVersionIRI) add(fed, NS.owl + 'priorVersion', nn(m.previousVersionIRI));
  for (const p of m.pins) {
    const v = nn(p.versionIRI);
    add(fed, p.role === 'member' ? NS.dcterms + 'hasPart' : NS.dcterms + 'requires', v);
    add(v, NS.dcterms + 'isVersionOf', nn(p.ontologyIRI));
    add(v, NS.owl + 'versionInfo', literal(p.version));
    add(v, NS.dcterms + 'title', literal(p.title, 'en'));
    checksum(p.versionIRI, p.hash);
  }
  add(fed, NS.owl + 'imports', nn(m.closure.iri));
  checksum(m.closure.iri, m.closure.hash);
  add(fed, NS.sh + 'shapesGraph', nn(m.shapes.iri));
  checksum(m.shapes.iri, m.shapes.hash);
  return new OntologyGraph(s, { owl: NS.owl, dcterms: NS.dcterms, sh: NS.sh, spdx: SPDX, xsd: NS.xsd });
}

const parse = (v: string) => (/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v) ?? []).slice(1, 4).map((x) => Number(x ?? 0));

/** How big a step one version to another is. */
export function versionStep(from: string, to: string): ChangeLevel {
  const [a, b] = [parse(from), parse(to)];
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return 'patch';
}

const RANK: Record<ChangeLevel, number> = { patch: 0, minor: 1, major: 2 };

/**
 * The version a new release should take, from what changed since the last one: a member removed, or
 * moved by a major version, is major; a member added, or moved by a minor version, is minor; anything
 * else is a patch. The first release is 1.0.0.
 */
export function suggestFederationVersion(previous: { version: string; pins: Pick<FederationPin, 'role' | 'ontologyIRI' | 'version'>[] } | undefined, next: Pick<FederationPin, 'role' | 'ontologyIRI' | 'version'>[]): { version: string; level: ChangeLevel; reasons: string[] } {
  if (!previous) return { version: '1.0.0', level: 'major', reasons: ['first release'] };
  let level: ChangeLevel = 'patch';
  const reasons: string[] = [];
  const raise = (l: ChangeLevel, why: string) => {
    if (RANK[l] > RANK[level]) level = l;
    reasons.push(why);
  };
  const members = (ps: typeof next) => new Map(ps.filter((p) => p.role === 'member').map((p) => [p.ontologyIRI, p.version]));
  const [before, after] = [members(previous.pins), members(next)];
  for (const [iri, v] of after) {
    const old = before.get(iri);
    if (old === undefined) raise('minor', `added ${iri}`);
    else if (old !== v) raise(versionStep(old, v), `${iri} ${old} → ${v}`);
  }
  for (const iri of before.keys()) if (!after.has(iri)) raise('major', `removed ${iri}`);
  return { version: bumpVersion(previous.version, level), level, reasons };
}
