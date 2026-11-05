import { createHash } from 'node:crypto';
import { OntologyGraph } from '@concord/core';
import type { ChangeRequest, OntologyProject, PublicHold, PublicHoldReview, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { transaction, get, HttpError, list, put, remove } from '../db.js';
import { getUser } from '../services/users.js';
import { requireRole, updateProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { findSecrets, secretsFor } from '../services/redact.js';
import { publishedRelease } from './published.js';

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

type Checked = Pick<OntologyProject, 'id' | 'slug' | 'publishedWithApproval'>;

/**
 * What's held for an ontology. Fails closed: an ontology that predates the
 * check and has no hold record yet (holding it failed, or hasn't run) has
 * every version held, until holdLegacy records it.
 */
export async function holdOf(project: Checked): Promise<PublicHold | undefined> {
  const saved = await get<PublicHold>('kv', key(project.id));
  if (saved || project.publishedWithApproval) return saved;
  return { id: key(project.id), ontologyId: project.id, versions: ['draft', ...ontologyStore.versions(project)], since: clock.iso() };
}
export const isHeld = async (project: Checked, version: string) => !!(await holdOf(project))?.versions.includes(version);
/**
 * Whether everything in this ontology's history was published under the
 * approval rules: true only for ontologies created since. An older one keeps
 * its hold record for good, even once every version is approved, because its
 * git history still holds what was never approved (a draft repaired since,
 * say), so its repository is never pushed anywhere as it is.
 */
export const historyApproved = async (project: Checked) => !!project.publishedWithApproval && !await get<PublicHold>('kv', key(project.id));
/** Anything of this ontology waiting for approval (then nothing of it leaves Concord, such as a push to GitHub). */
export const anyHeld = async (project: Checked) => ((await holdOf(project))?.versions.length ?? 0) > 0;

/**
 * Holds every version of an ontology that predates the check, once. The
 * hold is written before the ontology is marked as checked, so a run that
 * stops in between holds it again (the same versions) next time; until the
 * record exists, holdOf holds everything anyway.
 */
export async function holdLegacy(project: OntologyProject) { return await transaction(async () => {
  if (project.publishedWithApproval) return;
  if (!await get<PublicHold>('kv', key(project.id))) {
    const hold = (await holdOf(project))!;
    await put('kv', hold);
    console.log(`[public] holding ${project.slug} (${hold.versions.join(', ')}) until a steward approves what it publishes`);
  }
  await updateProject({ ...project, publishedWithApproval: true });
}); }

/** A release published while the working draft is held carries what's held: it's held too. */
const claimsKey = (ontologyId: string, version: string) => `public-hold-claims:${ontologyId}:${version}`;

/**
 * Hold `version` before a publish writes it, if the working draft is held. Every publish that does takes a claim
 * on the hold, so one that fails can't take back a hold another one still relies on. True if this call took a
 * claim: the caller must then call dropHoldClaim once it's done, whatever happened.
 */
export async function holdReleaseIfDraftHeld(project: OntologyProject, version: string): Promise<boolean> { return await transaction(async () => {
  const hold = await holdOf(project);
  if (!hold?.versions.includes('draft')) return false;
  if (!hold.versions.includes(version)) await put('kv', { ...hold, versions: [...hold.versions, version] });
  const k = claimsKey(project.id, version);
  await put('kv', { id: k, value: ((await get<{ id: string; value: number }>('kv', k))?.value ?? 0) + 1 });
  return true;
}); }

/**
 * A publish is done with its claim. The hold is taken back only when this publish wrote nothing, no other publish
 * still has a claim, and the version has no files at all: a publish that failed part-way may have left files the
 * public pages would serve as that version. Anything else keeps it held until a steward approves it.
 */
export async function dropHoldClaim(project: OntologyProject, version: string, wrote: boolean) { return await transaction(async () => {
  const k = claimsKey(project.id, version);
  const left = Math.max(0, ((await get<{ id: string; value: number }>('kv', k))?.value ?? 1) - 1);
  if (left) await put('kv', { id: k, value: left });
  else await remove('kv', k);
  if (wrote || left || ontologyStore.versions(project).includes(version)) return;
  const hold = await holdOf(project);
  if (!hold?.versions.includes(version)) return;
  await put('kv', { ...hold, versions: hold.versions.filter((v) => v !== version) });
}); }

/** The version a reference names, as the public sees versions: 'draft' or a release. Anything else (a commit, a tag) isn't public. */
export function publicVersion(project: OntologyProject, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '' || ref === 'working' || ref === 'draft') return 'draft';
  return ontologyStore.versions(project).includes(ref) ? ref : undefined;
}

/**
 * The one gate for reading an ontology. Signed-in people may read any
 * revision; everyone else (the public pages, downloads and the anonymous
 * API: view, terms, search, source, SPARQL) gets only the working draft or a
 * release, and nothing of a version waiting for approval.
 */
export async function readOntology(project: OntologyProject, ref: string | undefined, viewer: User | undefined): Promise<OntologyGraph> {
  if (viewer) return ontologyStore.at(project, ref);
  const version = publicVersion(project, ref);
  if (!version) throw new HttpError(404, `${project.title} has no published version “${ref}”`);
  if (await isHeld(project, version)) throw new HttpError(503, HELD_MESSAGE);
  return ontologyStore.at(project, version === 'draft' ? 'working' : version);
}
export const HELD_MESSAGE = 'This version is being reviewed before it is published. Please check back later.';

/** Exactly what a version publishes: its Turtle (every download is made from it), its release notes and its use case snapshot. */
async function content(project: OntologyProject, version: string) {
  if (version === 'draft') return { turtle: ontologyStore.readWorkingText(project), notes: '', snapshot: '' };
  // Read from the commit, never the checkout (ontologyStore.ts).
  const read = (name: string) => ontologyStore.releaseFile(project, version, name) ?? '';
  // The record the public page shows, not a rejected attempt at the same version.
  const release = await publishedRelease(project.id, version);
  return { turtle: read('ontology.ttl'), notes: release?.notes ?? '', snapshot: read('requirements.json') };
}
const fingerprintOf = (c: Awaited<ReturnType<typeof content>>) => createHash('sha256').update(JSON.stringify([c.turtle, c.notes, c.snapshot])).digest('base64url');

/**
 * What a steward reviews: everything the version publishes (its Turtle, its
 * release notes and its use case snapshot, in full), the fingerprint of
 * exactly that, and the statements and note lines that look like they name a
 * use case or a person. The hints can miss things, so the whole content is
 * there to read, and approving sends back the fingerprint of what was shown.
 */
export async function reviewHold(project: OntologyProject, version: string): Promise<PublicHoldReview> {
  const c = await content(project, version);
  const review: PublicHoldReview = { version, fingerprint: fingerprintOf(c), statements: 0, hints: [], turtle: c.turtle, notes: c.notes, snapshot: c.snapshot };
  const ucs = await list<UseCase>('useCases', project.id);
  const people = [...new Set((await Promise.all((await list<ChangeRequest>('changeRequests', project.id)).map(async (cr) => (await getUser(cr.authorId))?.name))).filter((n): n is string => !!n))];
  const secrets = await secretsFor(ucs, { people });
  for (const line of c.notes.split('\n')) {
    const kind = findSecrets(line, secrets)[0];
    if (kind) review.hints.push({ subject: 'release notes', predicate: '', object: line, kind });
  }
  for (const line of c.snapshot.split('\n')) {
    const kind = findSecrets(line, secrets)[0];
    if (kind) review.hints.push({ subject: 'use case snapshot', predicate: '', object: line.trim(), kind });
  }
  let graph: OntologyGraph;
  try {
    graph = await OntologyGraph.fromTurtle(c.turtle);
  } catch (err) {
    // One unreadable version doesn't stop the others being reviewed; this one can still be read and approved as it is.
    return { ...review, error: `Its Turtle couldn’t be read (${(err as Error).message.slice(0, 200)}), so nothing is highlighted. Read it all below.` };
  }
  for (const q of graph.store.getQuads(null, null, null, null)) {
    const text = q.object.termType === 'Literal' ? q.object.value : q.object.termType === 'NamedNode' ? q.object.value : '';
    const subject = q.subject.termType === 'NamedNode' ? q.subject.value : '(unnamed)';
    const kind = findSecrets(text, secrets)[0] ?? findSecrets(subject, secrets)[0];
    if (kind) review.hints.push({ subject, predicate: q.predicate.value, object: text, kind });
  }
  return { ...review, statements: graph.store.size, hints: review.hints.slice(0, 200) };
}

export async function listHolds(project: OntologyProject): Promise<PublicHoldReview[]> {
  const hold = await holdOf(project);
  if (!hold) return [];
  return Promise.all(
    hold.versions.map((v) =>
      reviewHold(project, v).catch((err: Error) => ({ version: v, fingerprint: '', statements: 0, hints: [], turtle: '', notes: '', snapshot: '', error: `It couldn’t be read: ${err.message.slice(0, 200)}` })),
    ),
  );
}

/** An owner or steward approves exactly what they reviewed; if it changed since, nothing is approved. */
export async function approveHold(project: OntologyProject, actor: User, version: string, fingerprint: unknown) { return await transaction(async () => {
  await requireRole(project.id, actor, ['owner', 'steward'], 'approve what a version publishes');
  const hold = await holdOf(project);
  if (!hold?.versions.includes(version)) throw new HttpError(404, `${version} isn’t waiting for approval`);
  if (typeof fingerprint !== 'string' || !fingerprint || fingerprint !== fingerprintOf(await content(project, version)))
    throw new HttpError(409, 'This version changed after you reviewed it. Review what it publishes again.');
  await put('kv', { ...hold, versions: hold.versions.filter((v) => v !== version), approved: [...(hold.approved ?? []), { version, by: actor.id, at: clock.iso(), fingerprint }] });
}); }
