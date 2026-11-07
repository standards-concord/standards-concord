/**
 * Federation releases: snapshots that pin every member of a federation, and everything the members
 * import, to a released version and its RDFC-1.0 content hash (computed by sparq's Rust engine), plus
 * the hash of the SHACL shapes derived from the members' OWL. A release is published as an OWL
 * ontology at /def/fed/<slug>/<version> that imports each member's version IRI; it never changes.
 *
 * A federation can be released only when it would pin exactly what it checked: every member at a
 * release (not a working draft), nothing imported that Concord can't pin, and the members usable together.
 */
import { Store } from 'n3';
import { deriveShapes, fedVersionIRI, manifestGraph, OntologyGraph, rdfcHash, shaclStore, suggestFederationVersion, unionGraph, type FederationPin } from '@concord/core';
import type { Federation, FederationRelease, FederationReleasePlan, User } from '@concord/shared';
import { clock } from '../clock.js';
import { HttpError, list, put, transaction } from '../db.js';
import { newId } from '../ids.js';
import { isHeld } from '../public/holds.js';
import { checkFederationNow, federationIRI, findFederation } from './federations.js';
import { hostedImportClosure } from './importClosure.js';
import { getProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';

const versionIRIOf = (ontologyIRI: string, version: string) => `${ontologyIRI.replace(/[#/]$/, '')}/${version}`;
const SEMVER = /^\d+\.\d+\.\d+$/;

const newer = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
/** A release's content never changes, so its hash is computed once. */
const hashCache = new Map<string, Promise<string>>();
const hashOf = (key: string, graph: () => Promise<OntologyGraph>) => {
  let h = hashCache.get(key);
  if (!h) {
    h = graph().then((g) => rdfcHash(g));
    hashCache.set(key, h);
    h.catch(() => hashCache.delete(key));
  }
  return h;
};

/** Newest version first (by version, not time: the simulated clock can give two releases the same instant). */
export const listFederationReleases = async (federationId: string) =>
  (await list<FederationRelease>('federationReleases', federationId)).sort((a, b) => (a.version === b.version ? 0 : newer(a.version, b.version) ? -1 : 1));

export async function findFederationRelease(f: Federation, version: string | undefined): Promise<FederationRelease | undefined> {
  const all = await listFederationReleases(f.id);
  return version ? all.find((r) => r.version === version) : all[0];
}


/** What a release would pin now, what stands in the way, and the version it should take. */
export async function releasePlan(f: Federation): Promise<FederationReleasePlan & { memberUnions: OntologyGraph[] }> {
  const blockers: string[] = [];
  const pins: FederationPin[] = [];
  /** Each member with everything it imports, under its own header (so its shapes are derived for its own namespace). */
  const memberUnions: OntologyGraph[] = [];
  const seen = new Set<string>();
  if (!f.members.length) blockers.push('Add at least one ontology first.');
  for (const m of f.members) {
    const p = await getProject(m.ontologyId);
    if (m.version === 'draft' || m.version.startsWith('fork:')) {
      blockers.push(m.version === 'draft' ? `${p.title} follows its working draft: pick one of its releases to pin.` : `${p.title} is a development fork: pick one of its releases to pin.`);
      continue;
    }
    if (await isHeld(p, m.version)) blockers.push(`${p.title} ${m.version} is being reviewed before it is published.`);
    const graph = await ontologyStore.at(p, m.version);
    seen.add(`${p.id}@${m.version}`);
    pins.push({ role: 'member', ontologyId: p.id, title: p.title, ontologyIRI: p.ontologyIRI, version: m.version, versionIRI: versionIRIOf(p.ontologyIRI, m.version), hash: await hashOf(`${p.id}@${m.version}`, async () => graph) });
    const closure = await hostedImportClosure(graph);
    memberUnions.push(unionGraph(graph, closure.imported));
    for (const u of closure.unresolved) blockers.push(`${p.title} imports ${u.iri}, which Concord ${u.reason === 'held' ? 'is still reviewing' : "doesn't host"}, so it can't be pinned.`);
    for (const r of closure.imported) {
      if (r.version === 'draft') {
        blockers.push(`${p.title} imports ${r.title}, which has no release yet, so it can't be pinned.`);
        continue;
      }
      const key = `${r.ontologyId ?? r.iri}@${r.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ontologyIRI = r.graph.ontologyIRI || r.iri;
      pins.push({ role: 'import', ...(r.ontologyId ? { ontologyId: r.ontologyId } : {}), title: r.title, ontologyIRI, version: r.version, versionIRI: versionIRIOf(ontologyIRI, r.version), hash: await hashOf(key, async () => r.graph) });
    }
  }
  if (!blockers.length) {
    const check = await checkFederationNow(f);
    if (!check.passed) blockers.push('Its ontologies can’t be used together yet: see “Used together”.');
  }
  const latest = (await listFederationReleases(f.id))[0];
  return { ready: blockers.length === 0, blockers, suggested: suggestFederationVersion(latest, pins), pins, memberUnions };
}

export async function publishFederationRelease(f: Federation, user: User | undefined, input: { version?: string; notes?: string }): Promise<FederationRelease> {
  if (!user) throw new HttpError(401, 'Sign in first');
  const fed = await findFederation(f.id);
  if (!user.isPlatformAdmin && !fed.ownerIds.includes(user.id)) throw new HttpError(403, 'Only the federation’s owners can release it');
  const plan = await releasePlan(fed);
  if (!plan.ready) throw new HttpError(409, plan.blockers.join(' '));
  const version = input.version?.trim() || plan.suggested.version;
  if (!SEMVER.test(version)) throw new HttpError(400, 'A version looks like 1.2.0');
  const latest = (await listFederationReleases(fed.id))[0];
  if (latest && !newer(version, latest.version)) throw new HttpError(400, `The version must be after ${latest.version}`);

  // The SHACL shapes, always derived from the members' OWL (never written by hand): each member's shapes,
  // derived with everything it imports loaded, in one shapes graph.
  const shapesStore = new Store();
  for (const u of plan.memberUnions) shapesStore.addQuads(shaclStore(deriveShapes(u)).getQuads(null, null, null, null));
  const shapes = new OntologyGraph(shapesStore, { sh: 'http://www.w3.org/ns/shacl#', xsd: 'http://www.w3.org/2001/XMLSchema#' });
  const shapesHash = await rdfcHash(shapes);
  const iri = federationIRI(fed.slug);
  const manifest = manifestGraph({ iri, version, title: fed.title, description: fed.description || undefined, issued: clock.iso(), previousVersion: latest?.version, pins: plan.pins, shapes: { iri: `${fedVersionIRI(iri, version)}/shapes`, hash: shapesHash } });
  return transaction(async () => {
    if ((await listFederationReleases(fed.id)).some((r) => r.version === version)) throw new HttpError(409, `${version} is already released`);
    const release: FederationRelease = {
      id: newId('fedrel'),
      federationId: fed.id,
      version,
      notes: input.notes?.trim() ?? '',
      pins: plan.pins,
      shapesHash,
      hash: await rdfcHash(manifest),
      ...(latest ? { previousVersion: latest.version } : {}),
      publishedAt: clock.iso(),
      publishedBy: user.id,
      manifest: await manifest.toTurtle(),
      shapes: await shapes.toTurtle(),
    };
    return await put('federationReleases', release, fed.id);
  });
}

/** For the API: a plan without the loaded graphs. */
export async function releasePlanOut(f: Federation): Promise<FederationReleasePlan> {
  const { memberUnions: _unions, ...plan } = await releasePlan(f);
  return plan;
}

export const releaseOut = ({ manifest: _m, shapes: _s, ...r }: FederationRelease) => r;
