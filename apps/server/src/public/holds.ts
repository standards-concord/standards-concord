import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeRequest, OntologyProject, PublicHold, PublicHoldReview, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, put } from '../db.js';
import { getUser } from '../services/users.js';
import { requireRole, updateProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { findSecrets, secretsFor } from '../services/redact.js';

/**
 * Versions published before a person approved what goes public.
 *
 * Older versions of Concord published what was drafted from use cases (which
 * may be private) without anyone approving it, and nothing can reliably spot
 * every name or title in it afterwards. So instead of cleaning it up
 * automatically, every version an ontology had when this check arrived (its
 * working draft and each release) is held: its public page and downloads say
 * it is being reviewed, until an owner or steward approves exactly what it
 * publishes. They can fix the working draft first with ordinary change
 * requests; a release can't change, so it is approved as it is or stays held.
 *
 * Ontologies created since don't need this: everything they publish was
 * approved as it was merged (see approvePublication in changeRequests.ts).
 * Nothing here edits an ontology.
 */

const key = (ontologyId: string) => `public-hold:${ontologyId}`;

export const holdOf = (ontologyId: string): PublicHold | undefined => get<PublicHold>('kv', key(ontologyId));
export const isHeld = (ontologyId: string, version: string) => !!holdOf(ontologyId)?.versions.includes(version);

/**
 * Holds every version of an ontology that predates the check, once. The
 * hold is written before the ontology is marked as checked, so a run that
 * stops in between holds it again (the same versions) next time.
 */
export function holdLegacy(project: OntologyProject) {
  if (project.publishedWithApproval) return;
  if (!holdOf(project.id)) {
    const versions = ['draft', ...ontologyStore.versions(project)];
    put('kv', { id: key(project.id), ontologyId: project.id, versions, since: clock.iso() } satisfies PublicHold);
    console.log(`[public] holding ${project.slug} (${versions.join(', ')}) until a steward approves what it publishes`);
  }
  updateProject({ ...project, publishedWithApproval: true });
}

/** A release published while the working draft is held carries what's held: it's held too. */
export function holdReleaseIfDraftHeld(project: OntologyProject, version: string) {
  const hold = holdOf(project.id);
  if (!hold?.versions.includes('draft') || hold.versions.includes(version)) return;
  put('kv', { ...hold, versions: [...hold.versions, version] });
}

/** Exactly what a version publishes: its Turtle (every download is made from it), its release notes and its use case snapshot. */
function content(project: OntologyProject, version: string) {
  const dir = ontologyStore.dir(project);
  if (version === 'draft') return { turtle: ontologyStore.readWorkingText(project), notes: '', snapshot: '' };
  const rel = path.join(dir, 'releases', version);
  const read = (name: string) => (fs.existsSync(path.join(rel, name)) ? fs.readFileSync(path.join(rel, name), 'utf8') : '');
  const release = list<{ version: string; notes: string }>('releases', project.id).find((r) => r.version === version);
  return { turtle: read('ontology.ttl'), notes: release?.notes ?? '', snapshot: read('requirements.json') };
}
const fingerprintOf = (c: ReturnType<typeof content>) => createHash('sha256').update(JSON.stringify([c.turtle, c.notes, c.snapshot])).digest('base64url');

/** The Turtle of a held version, for the steward reviewing it. */
export function heldTurtle(project: OntologyProject, version: string): string {
  if (!isHeld(project.id, version)) throw new HttpError(404, `${version} isn’t waiting for approval`);
  return content(project, version).turtle;
}

/**
 * What a steward reviews: the fingerprint of exactly what the version
 * publishes, and the statements and note lines that look like they name a
 * use case or a person. A hint only: the check misses things, so the whole
 * Turtle is there to read.
 */
export async function reviewHold(project: OntologyProject, version: string): Promise<PublicHoldReview> {
  const c = content(project, version);
  const ucs = list<UseCase>('useCases', project.id);
  const people = [...new Set(list<ChangeRequest>('changeRequests', project.id).map((cr) => getUser(cr.authorId)?.name).filter((n): n is string => !!n))];
  const secrets = secretsFor(ucs, { people });
  const graph = await ontologyStore.at(project, version === 'draft' ? 'working' : version);
  const local = (iri: string) => iri.replace(/^.*[#/]/, '') || iri;
  const hints: PublicHoldReview['hints'] = [];
  for (const q of graph.store.getQuads(null, null, null, null)) {
    const text = q.object.termType === 'Literal' ? q.object.value : '';
    const kind = findSecrets(text, secrets)[0] ?? (q.subject.termType === 'NamedNode' ? findSecrets(local(q.subject.value), secrets)[0] : undefined);
    if (kind) hints.push({ subject: q.subject.termType === 'NamedNode' ? local(q.subject.value) : '(unnamed)', predicate: local(q.predicate.value), object: text || local(q.object.value), kind });
  }
  for (const line of c.notes.split('\n')) {
    const kind = findSecrets(line, secrets)[0];
    if (kind) hints.push({ subject: 'release notes', predicate: '', object: line, kind });
  }
  return { version, fingerprint: fingerprintOf(c), statements: graph.store.size, hints: hints.slice(0, 200) };
}

export async function listHolds(project: OntologyProject): Promise<PublicHoldReview[]> {
  const hold = holdOf(project.id);
  return hold ? Promise.all(hold.versions.map((v) => reviewHold(project, v))) : [];
}

/** An owner or steward approves exactly what they reviewed; if it changed since, nothing is approved. */
export function approveHold(project: OntologyProject, actor: User, version: string, fingerprint: unknown) {
  requireRole(project.id, actor, ['owner', 'steward'], 'approve what a version publishes');
  const hold = holdOf(project.id);
  if (!hold?.versions.includes(version)) throw new HttpError(404, `${version} isn’t waiting for approval`);
  if (typeof fingerprint !== 'string' || fingerprint !== fingerprintOf(content(project, version)))
    throw new HttpError(409, 'This version changed after you reviewed it. Review what it publishes again.');
  put('kv', { ...hold, versions: hold.versions.filter((v) => v !== version), approved: [...(hold.approved ?? []), { version, by: actor.id, at: clock.iso(), fingerprint }] });
}
