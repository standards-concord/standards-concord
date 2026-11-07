/**
 * Federations: sets of ontologies, each at a chosen version (a release, 'fork:<slug>' for a development fork, or 'draft' to follow the working
 * draft), that are meant to be used together. An Advanced feature: anyone signed in can start one and
 * becomes its owner; its owners change it.
 *
 * Checking one loads every member with everything it imports and reasons over them alone and together
 * (core/federation.ts, on sparq in the reasoner worker). A proposed change to an ontology is also checked
 * against each federation that follows its working draft ("Across federations"): advisory, unless the
 * ontology's owners committed it to that federation, when breaking it fails the change.
 */
import { createHash } from 'node:crypto';
import { checkFederation, compareGraphs, federationUnion, upstreamOps, type FederationMemberInput, type OntologyGraph } from '@concord/core';
import type { FederationCheck, FederationImpact } from '@concord/core/types';
import type { ChangeRequest, Federation, FederationComparison, FederationDetail, FederationMember, FederationProposal, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, transaction } from '../db.js';
import { newId, slugify } from '../ids.js';
import { reasonInWorker } from '../reasoner/pool.js';
import { closureFingerprint, hostedImportClosure } from './importClosure.js';
import { findProject, getProject, rolesFor, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { findFork, listForks } from './forks.js';

/** Members a federation may have: each one is reasoned over alone and, for blame, in pairs. */
export const MAX_MEMBERS = 12;
/** A change is checked against at most this many federations that follow its ontology's draft. */
const MAX_IMPACT = 5;

export const federationIRI = (slug: string) => `${config.publicUrl}/def/fed/${encodeURIComponent(slug)}`;

export const listFederations = async () => (await list<Federation>('federations')).sort((a, b) => a.title.localeCompare(b.title));
export async function findFederation(idOrSlug: string): Promise<Federation> {
  const f = (await get<Federation>('federations', idOrSlug)) ?? (await list<Federation>('federations')).find((x) => x.slug === idOrSlug);
  if (!f) throw new HttpError(404, `No federation “${idOrSlug}”`);
  return f;
}
/** Federations that have this ontology as a member. */
export const federationsOf = async (ontologyId: string) => (await list<Federation>('federations')).filter((f) => f.members.some((m) => m.ontologyId === ontologyId));

/** Release versions, newest first. */
const newestFirst = (vs: string[]) => [...vs].sort((a, b) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
});

const canEdit = (f: Federation, user?: User) => !!user && (user.isPlatformAdmin || f.ownerIds.includes(user.id));

async function checkMembers(input: unknown): Promise<FederationMember[]> {
  if (!Array.isArray(input)) throw new HttpError(400, 'members must be a list');
  if (input.length > MAX_MEMBERS) throw new HttpError(400, `A federation can have at most ${MAX_MEMBERS} members`);
  const out: FederationMember[] = [];
  for (const raw of input) {
    const ontologyId = String((raw as FederationMember)?.ontologyId ?? '');
    const version = String((raw as FederationMember)?.version ?? 'draft') || 'draft';
    const project = await findProject(ontologyId);
    if (!project) throw new HttpError(400, `No ontology “${ontologyId}”`);
    if (out.some((m) => m.ontologyId === project.id)) throw new HttpError(400, `${project.title} is in the list twice`);
    if (version.startsWith('fork:')) {
      // An ontology's development fork, for trying a change in the federation before proposing it.
      if (!(await findFork(version.slice('fork:'.length), project))) throw new HttpError(400, `${project.title} has no fork “${version.slice('fork:'.length)}”`);
    } else if (version !== 'draft' && !(await ontologyStore.versions(project)).includes(version)) throw new HttpError(400, `${project.title} has no release ${version}`);
    out.push({ ontologyId: project.id, version });
  }
  return out;
}

/** A parent must exist, and following parents up from it must never come back to this federation. */
async function checkParent(parentId: unknown, own?: string): Promise<string | undefined> {
  if (parentId === undefined || parentId === null || parentId === '') return undefined;
  const parent = await findFederation(String(parentId));
  for (let p: Federation | undefined = parent, hops = 0; p; hops++) {
    if (p.id === own || hops > 20) throw new HttpError(400, 'A federation can’t extend itself, directly or through others');
    p = p.parentId ? await get<Federation>('federations', p.parentId) : undefined;
  }
  return parent.id;
}

async function uniqueSlug(title: string, own?: string) {
  const base = slugify(title);
  const taken = new Set((await list<Federation>('federations')).filter((f) => f.id !== own).map((f) => f.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export async function createFederation(user: User, input: { title: string; description?: string; members?: unknown; parentId?: unknown }): Promise<Federation> { return transaction(async () => {
  const now = clock.iso();
  const parentId = await checkParent(input.parentId);
  const f: Federation = {
    id: newId('fed'),
    slug: await uniqueSlug(input.title),
    title: input.title,
    description: input.description ?? '',
    ownerIds: [user.id],
    members: await checkMembers(input.members ?? []),
    ...(parentId ? { parentId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return await put('federations', f);
}); }

export async function updateFederation(f: Federation, user: User | undefined, input: { title?: string; description?: string; members?: unknown; parentId?: unknown }): Promise<Federation> { return transaction(async () => {
  if (!user) throw new HttpError(401, 'Sign in first');
  const now = await findFederation(f.id);
  if (!canEdit(now, user)) throw new HttpError(403, 'Only the federation’s owners can change it');
  const next: Federation = {
    ...now,
    ...(input.title ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.members !== undefined ? { members: await checkMembers(input.members) } : {}),
    updatedAt: clock.iso(),
  };
  if (input.parentId !== undefined) {
    const parentId = await checkParent(input.parentId, now.id);
    if (parentId) next.parentId = parentId;
    else delete next.parentId;
  }
  return await put('federations', next);
}); }

export async function federationDetail(f: Federation, viewer?: User): Promise<FederationDetail> {
  const memberInfo = await Promise.all(
    f.members.map(async (m) => {
      const p = await getProject(m.ontologyId);
      const roles = await rolesFor(p.id, viewer?.id);
      return {
        ...m,
        title: p.title,
        slug: p.slug,
        ontologyIRI: p.ontologyIRI,
        versions: newestFirst(await ontologyStore.versions(p)),
        forks: (await listForks(p.id)).filter((f) => f.status !== 'closed').map((f) => ({ slug: f.slug, title: f.title })),
        committed: !!p.committedFederations?.includes(f.id),
        canCommit: !!viewer && (viewer.isPlatformAdmin || roles.includes('owner') || roles.includes('steward')),
      };
    }),
  );
  const all = await list<Federation>('federations');
  const ref = (x: Federation) => ({ id: x.id, slug: x.slug, title: x.title });
  const parent = f.parentId ? all.find((x) => x.id === f.parentId) : undefined;
  const origin = f.forkOf ? all.find((x) => x.id === f.forkOf!.federationId) : undefined;
  const proposalInfo = await Promise.all(
    (f.proposals ?? []).map(async (p) => {
      const from = all.find((x) => x.id === p.fromFederationId);
      return { ...p, from: { slug: from?.slug ?? p.fromFederationId, title: from?.title ?? 'a deleted fork' }, changes: await memberChanges(f.members, p.members) };
    }),
  );
  const upstreamInfo = await Promise.all(
    (f.upstream ?? []).map(async (u) => {
      const cr = await get<ChangeRequest>('changeRequests', u.changeRequestId);
      const p = await get<OntologyProject>('ontologies', u.ontologyId);
      return { ...u, ontologyTitle: p?.title ?? u.ontologyId, ...(cr ? { number: cr.number, status: cr.status } : {}) };
    }),
  );
  return {
    ...f,
    memberInfo,
    canEdit: canEdit(f, viewer),
    ...(parent ? { parent: ref(parent) } : {}),
    children: all.filter((x) => x.parentId === f.id).map(ref),
    ...(origin && f.forkOf ? { forkedFrom: { ...ref(origin), kind: f.forkOf.kind } } : {}),
    forks: all.filter((x) => x.forkOf?.federationId === f.id).map((x) => ({ ...ref(x), kind: x.forkOf!.kind })),
    proposalInfo,
    upstreamInfo,
  };
}

/** Owners and stewards commit their ontology to a federation (changes that break it then fail), or take that back. */
export async function setCommitment(project: OntologyProject, f: Federation, committed: boolean, user: User | undefined) { return transaction(async () => {
  if (!user) throw new HttpError(401, 'Sign in first');
  const roles = await rolesFor(project.id, user.id);
  if (!user.isPlatformAdmin && !roles.some((r) => r === 'owner' || r === 'steward')) throw new HttpError(403, 'Only owners and stewards can commit an ontology to a federation');
  if (committed && !f.members.some((m) => m.ontologyId === project.id)) throw new HttpError(400, `${project.title} is not a member of ${f.title}`);
  const p = await getProject(project.id);
  const set = new Set(p.committedFederations ?? []);
  if (committed) set.add(f.id);
  else set.delete(f.id);
  await updateProject({ ...p, committedFederations: [...set] });
}); }

/** A member's graph and import closure. `override` replaces one ontology's working draft (a proposed change). */
async function memberInputs(f: Federation, override?: { ontologyId: string; graph: OntologyGraph }): Promise<{ inputs: FederationMemberInput[]; key: string }> {
  const inputs: FederationMemberInput[] = [];
  const parts: string[] = [];
  for (const m of f.members) {
    const p = await getProject(m.ontologyId);
    const overridden = override && override.ontologyId === p.id && m.version === 'draft';
    const fork = m.version.startsWith('fork:') ? await findFork(m.version.slice('fork:'.length), p) : undefined;
    if (m.version.startsWith('fork:') && !fork) throw new HttpError(409, `${p.title}'s fork “${m.version.slice('fork:'.length)}” no longer exists`);
    const graph = overridden ? override.graph : fork ? await ontologyStore.graphAt(p, fork.head) : await ontologyStore.at(p, m.version === 'draft' ? 'working' : m.version);
    const closure = await hostedImportClosure(graph);
    inputs.push({ id: p.id, title: p.title, version: m.version, graph, closure });
    const revision = overridden ? `proposed:${createHash('sha256').update(await graph.toTurtle()).digest('hex').slice(0, 16)}` : fork ? `fork@${fork.head}` : m.version === 'draft' ? `draft@${await ontologyStore.head(p)}` : m.version;
    parts.push(`${p.id}@${revision}[${closureFingerprint(closure)}]`);
  }
  return { inputs, key: `${f.id}:${parts.join(';')}` };
}

const checkCache = new Map<string, Promise<FederationCheck>>();

/** The federation's check, as its members stand now (or with one ontology's draft replaced). Cached by exactly what was loaded. */
export async function checkFederationNow(f: Federation, override?: { ontologyId: string; graph: OntologyGraph }): Promise<FederationCheck> {
  const { inputs, key } = await memberInputs(f, override);
  let p = checkCache.get(key);
  if (!p) {
    p = checkFederation(federationIRI(f.slug), inputs, reasonInWorker, { now: () => clock.iso() });
    checkCache.set(key, p);
    p.catch(() => checkCache.delete(key));
    // Keep the cache small: proposed changes each add an entry.
    if (checkCache.size > 200) checkCache.delete(checkCache.keys().next().value!);
  }
  return p;
}

/**
 * What a proposed change (the ontology's draft as it would be) does to each federation that follows that
 * draft. Federations that pin a release aren't affected until someone moves them to a new one.
 */
export async function federationImpact(project: OntologyProject, after: OntologyGraph): Promise<FederationImpact[]> {
  const following = (await federationsOf(project.id)).filter((f) => f.members.some((m) => m.ontologyId === project.id && m.version === 'draft')).slice(0, MAX_IMPACT);
  const committed = new Set((await getProject(project.id)).committedFederations ?? []);
  const out: FederationImpact[] = [];
  for (const f of following) {
    try {
      const before = await checkFederationNow(f);
      const next = await checkFederationNow(f, { ontologyId: project.id, graph: after });
      const was = new Set(before.joint.unsatisfiable.map((u) => u.iri));
      out.push({
        federationId: f.id,
        slug: f.slug,
        title: f.title,
        committed: committed.has(f.id),
        passedBefore: before.passed,
        passedAfter: next.passed,
        newlyUnsatisfiable: next.joint.unsatisfiable.map((u) => u.iri).filter((c) => !was.has(c)),
        becomesInconsistent: before.joint.consistent && !next.joint.consistent,
        ...(next.joint.checked === 'none' ? { error: next.joint.error ?? 'the reasoner gave no verdict' } : {}),
      });
    } catch (e) {
      out.push({ federationId: f.id, slug: f.slug, title: f.title, committed: committed.has(f.id), passedBefore: false, passedAfter: false, newlyUnsatisfiable: [], becomesInconsistent: false, error: (e as Error).message });
    }
  }
  return out;
}

/** A change breaks a federation if it passed before and doesn't after (or it now can't be checked). */
export const breaks = (i: FederationImpact) => (i.passedBefore && !i.passedAfter) || i.newlyUnsatisfiable.length > 0 || i.becomesInconsistent;

const compareCache = new Map<string, Promise<FederationComparison>>();

/**
 * Federation `b` compared with `a`, term by term: which of `a`'s terms `b` keeps the same, refines
 * (tightens), loosens or contradicts, and what each has that the other doesn't. Each side is every
 * member with everything it imports; the reasoner supplies entailed superclasses.
 */
export async function compareFederations(a: Federation, b: Federation): Promise<FederationComparison> {
  const [ia, ib] = await Promise.all([memberInputs(a), memberInputs(b)]);
  const key = `${ia.key}|${ib.key}`;
  let p = compareCache.get(key);
  if (!p) {
    p = (async () => {
      const [ua, ub] = [federationUnion(federationIRI(a.slug), ia.inputs), federationUnion(federationIRI(b.slug), ib.inputs)];
      const [ra, rb] = [await reasonInWorker(ua), await reasonInWorker(ub)];
      const r = await compareGraphs(ua, ub, { reasonerA: ra, reasonerB: rb });
      const ref = (x: Federation) => ({ id: x.id, slug: x.slug, title: x.title });
      return { a: ref(a), b: ref(b), ...r };
    })();
    compareCache.set(key, p);
    p.catch(() => compareCache.delete(key));
    if (compareCache.size > 50) compareCache.delete(compareCache.keys().next().value!);
  }
  return p;
}

/** How one list of members differs from another, in plain words. */
async function memberChanges(from: FederationMember[], to: FederationMember[]): Promise<string[]> {
  const title = async (id: string) => (await get<OntologyProject>('ontologies', id))?.title ?? id;
  const label = (v: string) => (v === 'draft' ? 'its working draft' : v.startsWith('fork:') ? `its fork ${v.slice('fork:'.length)}` : v);
  const out: string[] = [];
  for (const m of to) {
    const was = from.find((x) => x.ontologyId === m.ontologyId);
    if (!was) out.push(`adds ${await title(m.ontologyId)} (${label(m.version)})`);
    else if (was.version !== m.version) out.push(`moves ${await title(m.ontologyId)} from ${label(was.version)} to ${label(m.version)}`);
  }
  for (const m of from) if (!to.some((x) => x.ontologyId === m.ontologyId)) out.push(`removes ${await title(m.ontologyId)}`);
  return out;
}

/**
 * A copy of a federation that someone else can change. A development fork is meant to come back: its
 * owners propose its ontology choices to the original. A divergent fork goes its own way.
 */
export async function forkFederation(f: Federation, user: User, input: { title?: string; kind?: string }): Promise<Federation> { return transaction(async () => {
  const kind = input.kind === 'divergent' ? 'divergent' : 'development';
  const title = input.title?.trim() || `${f.title} (fork)`;
  const now = clock.iso();
  const fork: Federation = {
    id: newId('fed'),
    slug: await uniqueSlug(title),
    title,
    description: f.description,
    ownerIds: [user.id],
    members: f.members.map((m) => ({ ...m })),
    ...(f.parentId ? { parentId: f.parentId } : {}),
    forkOf: { federationId: f.id, kind },
    createdAt: now,
    updatedAt: now,
  };
  return await put('federations', fork);
}); }

/** A development fork's owners propose its ontology choices back to the federation it came from. */
export async function proposeBack(fork: Federation, user: User | undefined, note?: string): Promise<Federation> { return transaction(async () => {
  if (!user) throw new HttpError(401, 'Sign in first');
  const now = await findFederation(fork.id);
  if (!canEdit(now, user)) throw new HttpError(403, 'Only the fork’s owners can propose it back');
  if (now.forkOf?.kind !== 'development') throw new HttpError(400, 'Only a development fork is proposed back; a divergent fork goes its own way');
  const original = await findFederation(now.forkOf.federationId);
  if (!(await memberChanges(original.members, now.members)).length) throw new HttpError(400, `This fork picks the same ontologies and versions as ${original.title}`);
  const proposal: FederationProposal = { id: newId('fedprop'), fromFederationId: now.id, members: now.members.map((m) => ({ ...m })), note: note?.trim() ?? '', by: user.id, at: clock.iso(), status: 'open' };
  // One open proposal per fork: a newer one replaces it.
  const proposals = [...(original.proposals ?? []).filter((p) => !(p.fromFederationId === now.id && p.status === 'open')), proposal];
  return await put('federations', { ...original, proposals, updatedAt: clock.iso() });
}); }

/** The original's owners accept a proposal (its ontology choices become theirs) or decline it. */
export async function decideProposal(f: Federation, proposalId: string, user: User | undefined, accept: boolean): Promise<Federation> { return transaction(async () => {
  if (!user) throw new HttpError(401, 'Sign in first');
  const now = await findFederation(f.id);
  if (!canEdit(now, user)) throw new HttpError(403, 'Only the federation’s owners can decide on a proposal');
  const p = (now.proposals ?? []).find((x) => x.id === proposalId);
  if (!p) throw new HttpError(404, 'No such proposal');
  if (p.status !== 'open') throw new HttpError(409, `This proposal was already ${p.status}`);
  const decided: FederationProposal = { ...p, status: accept ? 'accepted' : 'declined', decidedBy: user.id, decidedAt: clock.iso() };
  return await put('federations', {
    ...now,
    ...(accept ? { members: await checkMembers(p.members) } : {}),
    proposals: (now.proposals ?? []).map((x) => (x.id === p.id ? decided : x)),
    updatedAt: clock.iso(),
  });
}); }

/**
 * Hands terms of this federation upstream: proposes them, as a change request, to an ontology of the
 * federation it extends (say, UK financial services handing settled terms to the UK government's
 * ontology). Each term is re-created in the target's namespace, linked back with skos:exactMatch.
 */
export async function proposeUpstream(f: Federation, user: User | undefined, input: { ontologyId: string; terms: string[]; title?: string; description?: string }) {
  if (!user) throw new HttpError(401, 'Sign in first');
  const fed = await findFederation(f.id);
  if (!canEdit(fed, user)) throw new HttpError(403, 'Only the federation’s owners can hand its terms upstream');
  if (!fed.parentId) throw new HttpError(400, 'Only a federation that extends another hands terms upstream');
  const parent = await findFederation(fed.parentId);
  if (!parent.members.some((m) => m.ontologyId === input.ontologyId)) throw new HttpError(400, `Pick an ontology of ${parent.title}`);
  if (!input.terms.length) throw new HttpError(400, 'Pick at least one term');
  const target = await getProject(input.ontologyId);
  const { inputs } = await memberInputs(fed);
  const plan = upstreamOps(federationUnion(federationIRI(fed.slug), inputs), input.terms, await ontologyStore.working(target));
  if (!plan.ops.length) throw new HttpError(400, plan.warnings.join(' ') || 'None of those terms can be handed upstream');
  const check = await checkFederationNow(fed);
  const evidence = [
    `Handed upstream from the federation “${fed.title}”, which extends “${parent.title}”.`,
    `It uses these terms together with: ${inputs.map((i) => `${i.title} (${i.version === 'draft' ? 'working draft' : i.version.startsWith('fork:') ? `fork ${i.version.slice('fork:'.length)}` : i.version})`).join(', ')}.`,
    check.passed ? 'Its ontologies currently work together.' : 'Note: its ontologies currently have problems when used together.',
    ...(plan.warnings.length ? ['', 'Not carried over:', ...plan.warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
  const { createChangeRequest } = await import('./changeRequests.js');
  const { rolesFor: roles, setRoles } = await import('./ontologies.js');
  if (!(await roles(target.id, user.id)).length) await setRoles(target.id, user.id, ['contributor']);
  const cr = await createChangeRequest(target, user, {
    title: input.title?.trim() || `Adopt ${plan.ops.length === 1 ? 'a term' : `${plan.ops.length} terms`} from ${fed.title}`,
    description: [input.description?.trim(), evidence].filter(Boolean).join('\n\n'),
    kind: 'feature',
    origin: { type: 'federation', federationId: fed.id, federationSlug: fed.slug, federationTitle: fed.title },
    ops: plan.ops,
    warnings: plan.warnings,
  });
  await transaction(async () => {
    const now = await findFederation(fed.id);
    await put('federations', { ...now, upstream: [...(now.upstream ?? []), { changeRequestId: cr.id, ontologyId: target.id, mapping: plan.mapping, by: user.id, at: clock.iso() }], updatedAt: clock.iso() });
  });
  return { changeRequest: cr, mapping: plan.mapping, warnings: plan.warnings };
}
