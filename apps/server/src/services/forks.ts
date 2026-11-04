import { applyChangeOps, ChangeOpError, compactIRI, FORMAT_INFO, validate, type OntologyGraph } from '@concord/core';
import type { ChangeOp, OutputFormat, ValidationReport } from '@concord/core/types';
import type {
  ChangeRequest,
  ForkCheck,
  ForkStatus,
  ForkSummary,
  ForkTerm,
  ForkUrls,
  OntologyFork,
  OntologyProject,
  User,
} from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put } from '../db.js';
import { newId, slugify } from '../ids.js';
import type { ProposedTerm } from '../llm/schemas.js';
import { createChangeRequest, draftFromNaturalLanguage, getCR, updateOps } from './changeRequests.js';
import { fairContext } from './fairResolution.js';
import { competencyTests, findProject, getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { proposalToOps } from './proposals.js';
import { getUser, logActivity, publicUser } from './users.js';

/**
 * Development forks.
 *
 * A developer who needs a term the standard doesn't have yet forks the
 * ontology, adds the term, and imports the fork's URL in their application
 * straight away. The fork's edits are proposed upstream as one change
 * request, which goes through the ontology's normal governance. At the start
 * of each development session, their agent calls `check` to see whether the
 * terms have landed, and gets a migration plan when they have.
 *
 * - A fork is a git branch `forks/<slug>` in the ontology's repository. Its
 *   commits never touch main, and the branch can be pushed to GitHub as-is.
 * - New terms keep the upstream namespace (vol:VolunteeringActivity, not a
 *   fork-specific IRI). Data written against the fork stays valid when the
 *   term lands, so migrating only means switching the import URL.
 * - The fork document is stamped with its own owl:versionIRI (its public URL)
 *   and a semver pre-release owl:versionInfo such as 1.0.0-fork.hours.3, with
 *   owl:priorVersion pointing at the release it was taken from.
 */

/** Where public ontology documents live; fork documents sit under /def/<slug>/forks/. */
const PUBLIC_BASE = '/def';
const OPEN_CR = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'];
const CR_STATE: Record<string, string> = {
  draft: 'a draft',
  triage: 'being triaged',
  review: 'in review',
  voting: 'being voted on',
  approved: 'approved and waiting to be merged',
  'needs-work': 'waiting for changes',
  merged: 'merged',
  released: 'released',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
};

const save = (f: OntologyFork) => {
  f.updatedAt = clock.iso();
  return put('forks', f, f.ontologyId);
};

export const listForks = (ontologyId: string) => list<OntologyFork>('forks', ontologyId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
export const forksOwnedBy = (userId: string) => list<OntologyFork>('forks').filter((f) => f.ownerId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** A fork by id (frk_…), "<ontology>/<fork-slug>", or a fork slug within `project`. */
export function findFork(ref: string, project?: OntologyProject): OntologyFork | undefined {
  const byId = get<OntologyFork>('forks', ref);
  if (byId) return byId;
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const p = findProject(ref.slice(0, slash));
    return p ? listForks(p.id).find((f) => f.slug === ref.slice(slash + 1)) : undefined;
  }
  if (project) return listForks(project.id).find((f) => f.slug === ref);
  const matches = list<OntologyFork>('forks').filter((f) => f.slug === ref);
  return matches.length === 1 ? matches[0] : undefined;
}

export function mustFindFork(ref: string, project?: OntologyProject): OntologyFork {
  const f = findFork(ref, project);
  if (!f) throw new HttpError(404, `No fork called “${ref}”`);
  return f;
}

/* ------------------------------------------------------------------------ */
/* URLs and version strings                                                  */
/* ------------------------------------------------------------------------ */

/** File extensions offered for imports, by format (same as the public version pages). */
const URL_FORMATS: OutputFormat[] = ['turtle', 'jsonld', 'rdfxml', 'ntriples', 'manchester', 'linkml', 'shacl'];

const publicRoot = (p: Pick<OntologyProject, 'slug'>) => `${config.webUrl}${PUBLIC_BASE}/${encodeURIComponent(p.slug)}`;

function documentUrls(root: string): Record<string, string> {
  return Object.fromEntries(URL_FORMATS.map((f) => [f, `${root}.${FORMAT_INFO[f].extension}`]));
}

export function forkUrls(p: Pick<OntologyProject, 'slug'>, f: Pick<OntologyFork, 'slug'>): ForkUrls {
  const iri = `${publicRoot(p)}/forks/${encodeURIComponent(f.slug)}`;
  return { iri, formats: documentUrls(iri), app: `${config.webUrl}/o/${encodeURIComponent(p.slug)}/forks/${encodeURIComponent(f.slug)}` };
}

/** Public URL of a released version, or of the working draft. */
export const versionUrl = (p: Pick<OntologyProject, 'slug'>, version: string | 'draft') => `${publicRoot(p)}/${version}`;
const releaseVersionIRI = (p: OntologyProject, version: string) => `${p.ontologyIRI.replace(/[#/]$/, '')}/${version}`;

export const forkVersion = (f: Pick<OntologyFork, 'baseVersion' | 'slug' | 'revision'>) => `${f.baseVersion}-fork.${f.slug}.${f.revision}`;

/** The fork document's own version metadata, so tools can tell it apart from a release. */
function stamp(graph: OntologyGraph, p: OntologyProject, f: OntologyFork): OntologyGraph {
  return applyChangeOps(graph, [
    {
      op: 'setMetadata',
      set: {
        versionIRI: forkUrls(p, f).iri,
        versionInfo: forkVersion(f),
        ...(f.baseVersion !== '0.0.0' ? { priorVersion: releaseVersionIRI(p, f.baseVersion) } : {}),
        modified: clock.iso().slice(0, 10),
      },
    },
  ]).graph;
}

/* ------------------------------------------------------------------------ */
/* Replaying edits                                                           */
/* ------------------------------------------------------------------------ */

const alreadyThere = (message: string) => /already (exists|has|imported)/.test(message);

/**
 * Applies the fork's edits one at a time on another graph (the latest
 * upstream draft). Edits whose result is already there, because the change
 * has landed upstream, are skipped; any other failure is a conflict.
 */
export function replay(graph: OntologyGraph, ops: ChangeOp[], ctx: Parameters<typeof applyChangeOps>[2] = {}) {
  let g = graph;
  const applied: ChangeOp[] = [];
  const alreadyUpstream: ChangeOp[] = [];
  const conflicts: { op: ChangeOp; message: string }[] = [];
  for (const op of ops) {
    try {
      g = applyChangeOps(g, [op], ctx).graph;
      applied.push(op);
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof ChangeOpError && alreadyThere(message)) alreadyUpstream.push(op);
      else conflicts.push({ op, message });
    }
  }
  return { graph: g, applied, alreadyUpstream, conflicts };
}

/** The terms a list of edits adds or changes, in order. */
export function termsOf(ops: ChangeOp[], namespace: string): { iri: string; change: 'added' | 'changed'; kind: string; label?: string }[] {
  const out = new Map<string, { iri: string; change: 'added' | 'changed'; kind: string; label?: string }>();
  const touch = (iri: string, change: 'added' | 'changed', kind: string, label?: string) => {
    const prev = out.get(iri);
    if (!prev) out.set(iri, { iri, change, kind, label });
    else if (change === 'added') out.set(iri, { ...prev, change, kind, label: label ?? prev.label });
  };
  for (const op of ops) {
    switch (op.op) {
      case 'addClass':
        touch(namespace + op.localName, 'added', 'class', op.label);
        break;
      case 'addObjectProperty':
        touch(namespace + op.localName, 'added', 'objectProperty', op.label);
        break;
      case 'addDatatypeProperty':
        touch(namespace + op.localName, 'added', 'datatypeProperty', op.label);
        break;
      case 'addIndividual':
        touch(namespace + op.localName, 'added', 'individual', op.label);
        break;
      case 'addRestriction':
      case 'removeRestriction':
        touch(op.classIri, 'changed', 'class');
        break;
      case 'addDisjointness':
      case 'removeDisjointness':
        for (const c of op.classes) touch(c, 'changed', 'class');
        break;
      case 'setMetadata':
      case 'addImport':
        break;
      default:
        touch(op.iri, 'changed', 'term');
    }
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

function requireOwner(f: OntologyFork, user: User | undefined, action: string) {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (f.ownerId !== user.id && !user.isPlatformAdmin) throw new HttpError(403, `Only the fork's owner can ${action}`);
}

function uniqueForkSlug(ontologyId: string, base: string) {
  const taken = new Set(listForks(ontologyId).map((f) => f.slug));
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

export async function createFork(p: OntologyProject, owner: User, input: { name: string; purpose?: string }): Promise<OntologyFork> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'Give the fork a name');
  const slug = uniqueForkSlug(p.id, slugify(name).replace(/^-+|-+$/g, '') || 'fork');
  const now = clock.iso();
  const fork: OntologyFork = {
    id: newId('frk'),
    slug,
    ontologyId: p.id,
    ownerId: owner.id,
    title: name,
    purpose: input.purpose?.trim() || undefined,
    branch: ontologyStore.forkBranch(slug),
    baseCommit: '',
    baseVersion: p.currentVersion,
    ops: [],
    revision: 0,
    head: '',
    status: 'active',
    changeRequestIds: [],
    createdAt: now,
    updatedAt: now,
  };
  fork.baseCommit = ontologyStore.createFork(p, slug);
  const graph = stamp(await ontologyStore.working(p), p, fork);
  fork.head = await ontologyStore.commitFork(p, slug, graph, `Fork ${p.title} ${p.currentVersion} as “${name}”${fork.purpose ? `\n\n${fork.purpose}` : ''}`, { name: owner.name, email: owner.email });
  save(fork);
  logActivity({ ontologyId: p.id, actorId: owner.id, type: 'fork.created', message: `forked ${p.title} as “${name}”`, link: `/o/${p.slug}/forks/${slug}` });
  return fork;
}

export interface ForkEditInput {
  /** Plain-language description, drafted into edits like a change request. */
  description?: string;
  /** Terms in the same shape the drafter produces (CURIEs and local names resolve against the fork). */
  terms?: ProposedTerm[];
  /** Engine edits, used as they are. */
  ops?: ChangeOp[];
  /** Commit message; defaults to the drafted title or the description's first line. */
  message?: string;
}

export interface ForkEditResult {
  fork: ForkSummary;
  ops: ChangeOp[];
  terms: ForkTerm[];
  warnings: string[];
  validation: Pick<ValidationReport, 'passed'> & { consistent: boolean; errors: string[]; warnings: string[] };
}

function validationBrief(v: ValidationReport) {
  return {
    passed: v.passed,
    consistent: v.reasoner.consistent && v.reasoner.unsatisfiable.length === 0,
    errors: v.lint.filter((i) => i.severity === 'error').map((i) => i.message),
    warnings: v.lint.filter((i) => i.severity === 'warning').map((i) => i.message),
  };
}

async function validateFork(p: OntologyProject, graph: OntologyGraph) {
  return validate(graph, { cqs: competencyTests(p.id), reasoner: 'owl', fair: await fairContext(graph.ontologyIRI) });
}

/** Add or change terms on the fork. Refuses edits that would make the ontology inconsistent. */
export async function editFork(f: OntologyFork, user: User | undefined, input: ForkEditInput): Promise<ForkEditResult> {
  requireOwner(f, user, 'edit it');
  if (f.status === 'closed') throw new HttpError(409, 'This fork is closed');
  const p = getProject(f.ontologyId);
  const current = await ontologyStore.forkGraph(p, f.slug);
  let ops = input.ops ?? [];
  let warnings: string[] = [];
  let message = input.message;
  if (!input.ops?.length && input.terms?.length) {
    ({ ops, warnings } = proposalToOps(current, input.terms, `fork ${f.slug}`));
  } else if (!input.ops?.length && input.description?.trim()) {
    const drafted = await draftFromNaturalLanguage(p, current, input.description, 'feature');
    ops = drafted.ops;
    warnings = drafted.warnings;
    message ||= drafted.title;
  }
  if (!ops.length) throw new HttpError(400, 'No edits could be worked out. Describe the terms to add (for example “Add a class Shift as a subclass of Session”), or pass them as structured terms.');

  let after: OntologyGraph;
  try {
    const r = applyChangeOps(current, ops, { author: user!.name, date: clock.iso().slice(0, 10), source: `${p.slug} fork ${f.slug}` });
    after = r.graph;
    warnings = [...warnings, ...r.warnings];
  } catch (err) {
    const msg = err instanceof ChangeOpError ? `Edit ${err.opIndex + 1} cannot be applied: ${err.message}` : (err as Error).message;
    throw new HttpError(400, msg);
  }
  const report = await validateFork(p, after);
  const brief = validationBrief(report);
  if (!brief.consistent) {
    const unsat = report.reasoner.unsatisfiable.map((i) => compactIRI(i, after.prefixes));
    throw new HttpError(422, `These edits would make the ontology logically inconsistent${unsat.length ? ` (unsatisfiable: ${unsat.join(', ')})` : ''}, so they were not applied.`);
  }

  f.revision += 1;
  f.ops = [...f.ops, ...ops];
  const subject = (message || input.description?.split('\n')[0] || 'Edit the fork').slice(0, 120);
  f.head = await ontologyStore.commitFork(p, f.slug, stamp(after, p, f), subject, { name: user!.name, email: user!.email });
  if (f.status === 'merged' || f.status === 'released') f.status = 'active';
  save(f);
  logActivity({ ontologyId: p.id, actorId: user!.id, type: 'fork.edited', message: `edited the fork “${f.title}”: ${subject}`, link: `/o/${p.slug}/forks/${f.slug}` });
  const summary = await forkSummary(f);
  const added = new Set(termsOf(ops, after.namespace).map((t) => t.iri));
  return { fork: summary, ops, terms: summary.terms.filter((t) => added.has(t.iri)), warnings, validation: brief };
}

/** The open change request a fork has upstream, if any. */
function openCR(f: OntologyFork): ChangeRequest | undefined {
  for (const id of [...f.changeRequestIds].reverse()) {
    const cr = get<ChangeRequest>('changeRequests', id);
    if (cr && OPEN_CR.includes(cr.status)) return cr;
  }
  return undefined;
}

function latestCR(f: OntologyFork): ChangeRequest | undefined {
  const id = f.changeRequestIds.at(-1);
  return id ? get<ChangeRequest>('changeRequests', id) : undefined;
}

/**
 * Propose the fork's edits upstream as one change request, which then follows
 * the ontology's governance policy. Proposing again while that request is open
 * updates its edits (earlier approvals stop counting, as for any edit).
 */
export async function proposeFork(f: OntologyFork, user: User | undefined, input: { title?: string; description?: string } = {}): Promise<{ fork: ForkSummary; changeRequest: ChangeRequest }> {
  requireOwner(f, user, 'propose it upstream');
  if (f.status === 'closed') throw new HttpError(409, 'This fork is closed');
  const p = getProject(f.ontologyId);
  const working = await ontologyStore.working(p);
  const { applied, conflicts } = replay(working, f.ops);
  if (conflicts.length) throw new HttpError(409, `The fork no longer applies cleanly to the latest draft: ${conflicts[0].message}. Sync the fork first.`);
  if (!applied.length) throw new HttpError(409, f.ops.length ? 'Everything in this fork is already in the working draft.' : 'The fork has no edits to propose yet.');

  const c = (iri: string) => compactIRI(iri, working.prefixes);
  const terms = termsOf(applied, working.namespace);
  const title = input.title?.trim() || `${terms.some((t) => t.change === 'added') ? 'Add' : 'Change'} ${terms.slice(0, 3).map((t) => c(t.iri)).join(', ')}${terms.length > 3 ? ` and ${terms.length - 3} more` : ''}`;
  const urls = forkUrls(p, f);
  const description =
    input.description?.trim() ||
    [
      f.purpose ? `Needed for: ${f.purpose}` : undefined,
      `Proposed from the development fork “${f.title}” (${forkVersion(f)}), which is already in use at <${urls.iri}>.`,
      `Terms: ${terms.map((t) => `${c(t.iri)} (${t.change})`).join(', ')}.`,
    ]
      .filter(Boolean)
      .join('\n\n');

  if (!rolesFor(p.id, user!.id).length) setRoles(p.id, user!.id, ['contributor']);
  const existing = openCR(f);
  let cr: ChangeRequest;
  if (existing) {
    cr = await updateOps(existing, user!, { ops: applied, title: input.title?.trim() || undefined, description: input.description?.trim() || undefined });
  } else {
    cr = await createChangeRequest(p, user!, { title, description, kind: 'feature', origin: { type: 'fork', forkId: f.id, forkSlug: f.slug }, ops: applied, submit: true });
    f.changeRequestIds.push(cr.id);
    logActivity({ ontologyId: p.id, actorId: user!.id, type: 'fork.proposed', message: `proposed the fork “${f.title}” upstream as #${cr.number}`, link: `/o/${p.slug}/changes/${cr.id}` });
  }
  f.status = 'proposed';
  f.proposedRevision = f.revision;
  save(f);
  return { fork: await forkSummary(f), changeRequest: getCR(cr.id) };
}

/**
 * Bring the fork up to date with upstream: replay its edits on the latest
 * working draft. Edits that have already landed are skipped. Refuses, and
 * changes nothing, if any edit conflicts with what upstream has done since.
 */
export async function syncFork(f: OntologyFork, user: User | undefined) {
  requireOwner(f, user, 'sync it');
  const p = getProject(f.ontologyId);
  const upstreamHead = ontologyStore.head(p);
  const working = await ontologyStore.working(p);
  const r = replay(working, f.ops, { author: getUser(f.ownerId)?.name, date: clock.iso().slice(0, 10), source: `${p.slug} fork ${f.slug}` });
  const c = (iri: string) => compactIRI(iri, working.prefixes);
  if (r.conflicts.length) {
    return {
      synced: false,
      fork: await forkSummary(f),
      conflicts: r.conflicts.map((x) => x.message),
      message: `Upstream has changed in a way that conflicts with ${r.conflicts.length} of this fork's edits. Edit the fork (or start a new one) to resolve it.`,
    };
  }
  const behind = ontologyStore.commitsSince(p, f.baseCommit);
  if (!behind) return { synced: false, fork: await forkSummary(f), conflicts: [], message: 'Already up to date with upstream.' };
  f.revision += 1;
  f.baseCommit = upstreamHead;
  f.baseVersion = p.currentVersion;
  f.head = await ontologyStore.commitFork(p, f.slug, stamp(r.graph, p, f), `Sync with ${p.title} ${p.currentVersion} (${upstreamHead.slice(0, 7)})`, { name: user!.name, email: user!.email }, [upstreamHead]);
  save(f);
  const landed = termsOf(r.alreadyUpstream, working.namespace).map((t) => c(t.iri));
  return {
    synced: true,
    fork: await forkSummary(f),
    conflicts: [],
    message: `Synced with upstream (${behind} new commit${behind === 1 ? '' : 's'}).${landed.length ? ` Already upstream: ${landed.join(', ')}.` : ''}`,
  };
}

export async function closeFork(f: OntologyFork, user: User | undefined) {
  requireOwner(f, user, 'close it');
  f.status = 'closed';
  save(f);
  logActivity({ ontologyId: f.ontologyId, actorId: user!.id, type: 'fork.closed', message: `closed the fork “${f.title}”`, link: `/o/${getProject(f.ontologyId).slug}/forks/${f.slug}` });
  return forkSummary(f);
}

/* ------------------------------------------------------------------------ */
/* Where the fork's terms stand upstream                                     */
/* ------------------------------------------------------------------------ */

async function upstreamGraphs(p: OntologyProject) {
  const working = await ontologyStore.working(p);
  const released = p.currentVersion !== '0.0.0' && ontologyStore.versions(p).includes(p.currentVersion) ? await ontologyStore.at(p, p.currentVersion) : undefined;
  return { working, released };
}

function termStatuses(f: OntologyFork, p: OntologyProject, working: OntologyGraph, released: OntologyGraph | undefined): ForkTerm[] {
  const cr = latestCR(f);
  const c = (iri: string) => compactIRI(iri, working.prefixes);
  const crState = cr ? (OPEN_CR.includes(cr.status) ? 'pending' : cr.status === 'merged' ? 'merged' : cr.status === 'released' ? 'released' : 'rejected') : 'not-proposed';
  return termsOf(f.ops, working.namespace).map((t) => {
    const base: ForkTerm = { iri: t.iri, curie: c(t.iri), label: t.label, kind: t.kind, change: t.change, upstream: 'not-proposed' };
    if (t.change === 'added') {
      if (released?.term(t.iri)) return { ...base, upstream: 'released', releasedIn: p.currentVersion };
      if (working.term(t.iri)) return { ...base, upstream: 'merged' };
      if (crState === 'merged' || crState === 'released') {
        // Review renamed it: look for a term with the same label and kind.
        const hit = t.label ? working.search(t.label, 5).find((x) => x.label?.toLowerCase() === t.label!.toLowerCase() && x.kind === t.kind) : undefined;
        return { ...base, upstream: 'missing', landedAs: hit?.iri };
      }
      return { ...base, upstream: crState };
    }
    // A change to an existing term: follow the change request.
    if (crState === 'released' || (crState === 'merged' && cr?.releaseId)) return { ...base, upstream: 'released', releasedIn: p.currentVersion };
    return { ...base, upstream: crState };
  });
}

function computeStatus(f: OntologyFork, terms: ForkTerm[]): ForkStatus {
  if (f.status === 'closed') return 'closed';
  if (terms.length && terms.every((t) => t.upstream === 'released' || (t.upstream === 'missing' && t.landedAs))) return 'released';
  if (terms.length && terms.every((t) => t.upstream === 'released' || t.upstream === 'merged' || (t.upstream === 'missing' && t.landedAs))) return 'merged';
  if (openCR(f)) return 'proposed';
  return 'active';
}

export async function forkSummary(f: OntologyFork): Promise<ForkSummary> {
  const p = getProject(f.ontologyId);
  const { working, released } = await upstreamGraphs(p);
  const terms = termStatuses(f, p, working, released);
  const status = computeStatus(f, terms);
  if (status !== f.status) {
    f.status = status;
    save(f);
  }
  const cr = latestCR(f);
  return {
    ...f,
    owner: publicUser(getUser(f.ownerId)),
    ontology: { id: p.id, slug: p.slug, title: p.title, prefix: p.prefix, currentVersion: p.currentVersion },
    version: forkVersion(f),
    urls: forkUrls(p, f),
    terms,
    changeRequest: cr ? { id: cr.id, number: cr.number, title: cr.title, status: cr.status, level: cr.classification?.level } : undefined,
    behindBy: ontologyStore.commitsSince(p, f.baseCommit),
  };
}

export async function forkDetail(f: OntologyFork) {
  const p = getProject(f.ontologyId);
  return { ...(await forkSummary(f)), history: ontologyStore.forkLog(p, f.slug, 30) };
}

/**
 * What to do about a fork at the start of a development session: keep using
 * it, sync it, or move the application back to the main ontology now that
 * the terms have landed.
 */
export async function checkFork(f: OntologyFork): Promise<ForkCheck> {
  const fork = await forkSummary(f);
  const p = getProject(f.ontologyId);
  const swap = (target: string) => [{ from: fork.urls.iri, to: target }, ...Object.entries(fork.urls.formats).map(([fmt, url]) => ({ from: url, to: `${target}.${FORMAT_INFO[fmt as OutputFormat].extension}` }))];
  const renames = fork.terms.filter((t) => t.upstream === 'missing' && t.landedAs).map((t) => ({ from: t.iri, to: t.landedAs! }));
  const lost = fork.terms.filter((t) => t.upstream === 'missing' && !t.landedAs);
  const cr = fork.changeRequest;
  const crText = cr ? `change request #${cr.number} (${CR_STATE[cr.status] ?? cr.status})` : 'no change request yet';
  const renameStep = renames.length ? [`Rename these terms in your code and data: ${renames.map((r) => `${r.from} → ${r.to}`).join(', ')}.`] : [];

  if (fork.status === 'released') {
    const target = versionUrl(p, p.currentVersion);
    return {
      fork,
      outcome: 'switch-to-release',
      message: `Everything in “${f.title}” is in ${p.title} ${p.currentVersion}. Switch your imports from the fork to the release.`,
      replace: swap(target),
      renames,
      steps: [
        `Replace ${fork.urls.iri} with ${target} in your imports (and the same for each file extension).`,
        ...renameStep,
        'Regenerate or re-import any classes or schemas generated from the ontology, then run your tests.',
        `Close the fork once nothing uses it (close_fork, or the Close button on ${fork.urls.app}).`,
      ],
    };
  }
  if (fork.status === 'merged') {
    const draft = versionUrl(p, 'draft');
    return {
      fork,
      outcome: 'switch-to-draft',
      message: `${crText[0].toUpperCase()}${crText.slice(1)} is merged into the ${p.title} working draft but not released yet. You can keep using the fork until the next release, or switch to the draft (which keeps changing until it is released).`,
      replace: swap(draft),
      renames,
      steps: [
        `Optional: replace ${fork.urls.iri} with ${draft} now, or wait for the next release and switch to it then.`,
        ...renameStep,
        'Check again at the start of your next session.',
      ],
    };
  }
  if (fork.status === 'closed') {
    return { fork, outcome: 'fork-closed', message: `The fork “${f.title}” is closed. It still resolves, but it won't get updates.`, replace: [], renames, steps: ['Move to the latest release, or create a new fork if you still need terms that are not in it.'] };
  }
  const steps: string[] = [];
  if (cr?.status === 'rejected' || cr?.status === 'withdrawn') steps.push(`Change request #${cr.number} was ${cr.status}. Read the reviewers' comments on it, then edit the fork and propose again, or keep the terms as a local extension.`);
  if (lost.length) steps.push(`These terms were not accepted as proposed: ${lost.map((t) => t.curie).join(', ')}. Check ${crText} for what replaced them.`);
  if (!cr) steps.push('When you are happy with the new terms, propose the fork upstream (propose_fork) so the standard can adopt them.');
  else if (cr.status !== 'rejected' && cr.status !== 'withdrawn') steps.push('Nothing to change in your application. Check again at the start of your next session.');
  if (fork.behindBy > 0) {
    steps.unshift(`Upstream has ${fork.behindBy} new commit${fork.behindBy === 1 ? '' : 's'} since you forked${p.currentVersion !== f.baseVersion ? ` (now at ${p.currentVersion})` : ''}. Sync the fork (sync_fork) to pick them up.`);
    return { fork, outcome: 'sync-fork', message: `“${f.title}” is behind upstream; sync it to pick up the latest changes. ${crText}.`, replace: [], renames, steps };
  }
  const why = cr && OPEN_CR.includes(cr.status) ? ` while change request #${cr.number} is ${CR_STATE[cr.status]}` : '';
  return { fork, outcome: 'keep-using-fork', message: `Keep using “${f.title}”${why}.`, replace: [], renames, steps };
}
