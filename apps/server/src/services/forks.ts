import { applyChangeOps, ChangeOpError, compactIRI, FORMAT_INFO, termDescription, validate, type OntologyGraph } from '@concord/core';
import type { ChangeOp, OutputFormat, ValidationReport } from '@concord/core/types';
import type {
  ChangeRequest,
  ForkCheck,
  ForkConflict,
  ForkStatus,
  ForkSummary,
  ForkSyncResult,
  ForkTerm,
  ForkUrls,
  OntologyFork,
  OntologyProject,
  User,
} from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { PUBLIC_BASE } from '../public/w3id.js';
import { get, HttpError, list, mustGet, put } from '../db.js';
import { newId, slugify } from '../ids.js';
import type { ProposedTerm } from '../llm/schemas.js';
import { createChangeRequest, draftFromNaturalLanguage, getCR, updateOps } from './changeRequests.js';
import { fairContext } from './fairResolution.js';
import { competencyTests, findProject, getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { describeOp, proposalToOps } from './proposals.js';
import { getUser, logActivity, publicUser } from './users.js';

/**
 * Development forks.
 *
 * A developer who needs a term the standard doesn't have yet forks the
 * ontology, adds the term, and imports the fork's URL in their application
 * straight away. The fork's edits are proposed upstream as one change
 * request, which goes through the ontology's normal governance. At the start
 * of each development session, their agent calls `check` to see whether the
 * edits have landed, and gets a migration plan when they have.
 *
 * - A fork is a git branch `forks/<slug>` in the ontology's repository. Its
 *   commits never touch main, and the branch can be pushed to GitHub as-is.
 * - New terms keep the upstream namespace (vol:VolunteeringActivity, not a
 *   fork-specific IRI). Data written against the fork stays valid when the
 *   term lands, so migrating only means switching the import URL.
 * - The fork document is stamped with its own owl:versionIRI (its public URL)
 *   and a semver pre-release owl:versionInfo such as 1.0.0-fork.hours.3, with
 *   owl:priorVersion pointing at the release it was taken from.
 * - `ops` are the fork's outstanding edits relative to `baseCommit`, so the
 *   fork is always base + ops. Syncing moves the base to the latest upstream
 *   draft and keeps only the edits that haven't landed; git keeps the history.
 * - Whether an edit has landed is decided by content, three ways: for each
 *   term the fork touches, compare what the base, the fork and upstream say
 *   about it (termDescription, which ignores provenance). Upstream saying
 *   exactly what the fork says means landed; upstream saying something else
 *   that differs from the base means both sides changed it, a conflict.
 */

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
/** Header fields the fork stamps itself; a user's setMetadata of these isn't compared. */
const STAMPED = new Set(['versionIRI', 'versionInfo', 'priorVersion', 'modified', 'backwardCompatibleWith', 'incompatibleWith', 'issued']);

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
/* One change at a time per fork                                             */
/* ------------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after any other change to the same fork has finished, with the
 * fork re-read from the database, so two edits can't both read the same head
 * and have one silently overwrite the other. (commitFork's compare-and-swap
 * on the branch is the second line of defence.)
 */
async function locked<T>(id: string, fn: (f: OntologyFork) => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => fn(mustGet<OntologyFork>('forks', id)));
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
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

/** Public URL of a released version, or of the working draft (the public pages, public/routes.ts); fork documents sit under /def/<slug>/forks/. */
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
/* What an edit touches, and comparing it across graphs                      */
/* ------------------------------------------------------------------------ */

/**
 * A key is something an edit can change: a term IRI, `import:<iri>` for an
 * owl:imports, or `meta:<field>` for an ontology header field.
 */
function describe(g: OntologyGraph, key: string): string {
  if (key.startsWith('import:')) return g.metadata().imports.includes(key.slice(7)) ? 'imported' : '';
  if (key.startsWith('meta:')) return JSON.stringify((g.metadata() as unknown as Record<string, unknown>)[key.slice(5)] ?? null);
  return termDescription(g, key);
}

function keyLabel(key: string, prefixes: Record<string, string>) {
  if (key.startsWith('import:')) return `owl:imports <${key.slice(7)}>`;
  if (key.startsWith('meta:')) return `the ontology's ${key.slice(5)}`;
  return compactIRI(key, prefixes);
}

/** The keys each edit touches, by applying the edits one at a time on the graph they were made against. */
function keysPerOp(base: OntologyGraph, ops: ChangeOp[]): string[][] {
  let g = base;
  return ops.map((op) => {
    const keys = new Set<string>();
    if (op.op === 'addImport') keys.add(`import:${op.iri}`);
    else if (op.op === 'setMetadata') for (const field of Object.keys(op.set)) if (!STAMPED.has(field)) keys.add(`meta:${field}`);
    try {
      const r = applyChangeOps(g, [op]);
      // The header is compared field by field (meta:/import: keys), never as one term: the fork stamps its own version.
      for (const t of r.touched) if (t !== base.ontologyIRI) keys.add(t);
      g = r.graph;
    } catch {
      // Recorded edits always applied to their base; if not, fall back to the IRIs the edit names.
    }
    if (!keys.size) for (const t of termsOf([op], base.namespace)) keys.add(t.iri);
    return [...keys];
  });
}

/** The terms a list of edits names, with a kind and label for display. */
export function termsOf(ops: ChangeOp[], namespace: string): { iri: string; kind: string; label?: string }[] {
  const out = new Map<string, { iri: string; kind: string; label?: string }>();
  const touch = (iri: string, kind: string, label?: string) => out.set(iri, { iri, kind: out.get(iri)?.kind ?? kind, label: label ?? out.get(iri)?.label });
  for (const op of ops) {
    switch (op.op) {
      case 'addClass':
        touch(namespace + op.localName, 'class', op.label);
        break;
      case 'addObjectProperty':
        touch(namespace + op.localName, 'objectProperty', op.label);
        break;
      case 'addDatatypeProperty':
        touch(namespace + op.localName, 'datatypeProperty', op.label);
        break;
      case 'addIndividual':
        touch(namespace + op.localName, 'individual', op.label);
        break;
      case 'addRestriction':
      case 'removeRestriction':
        touch(op.classIri, 'class');
        break;
      case 'addDisjointness':
      case 'removeDisjointness':
        for (const c of op.classes) touch(c, 'class');
        break;
      case 'setMetadata':
      case 'addImport':
        break;
      default:
        touch(op.iri, 'term');
    }
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------------ */
/* Rebasing: carrying the fork's outstanding edits onto the latest upstream  */
/* ------------------------------------------------------------------------ */

interface RebasePlan {
  upstreamHead: string;
  upstream: OntologyGraph;
  /** Keys whose fork version is already upstream. */
  landed: string[];
  conflicts: ForkConflict[];
  /** The edits still needed on top of upstream. */
  remaining: ChangeOp[];
  /** Upstream with the remaining edits applied (when there are no conflicts). */
  result?: OntologyGraph;
}

async function rebasePlan(p: OntologyProject, f: OntologyFork, author?: string): Promise<RebasePlan> {
  const upstreamHead = ontologyStore.head(p);
  const upstream = await ontologyStore.working(p);
  const base = await ontologyStore.graphAt(p, f.baseCommit);
  const fork = await ontologyStore.forkGraph(p, f.slug);
  const label = (k: string) => keyLabel(k, upstream.prefixes);
  const perOp = keysPerOp(base, f.ops);
  const keys = [...new Set(perOp.flat())];
  const landed: string[] = [];
  const conflicts: ForkConflict[] = [];
  for (const k of keys) {
    const mine = describe(fork, k);
    const theirs = describe(upstream, k);
    if (theirs === mine) landed.push(k);
    else if (theirs !== describe(base, k))
      conflicts.push({ iri: k, curie: label(k), message: `${label(k)} has changed upstream since this fork was last synced, and not in the same way as in the fork.` });
  }
  const remaining = f.ops.filter((_, i) => !perOp[i].length || perOp[i].some((k) => !landed.includes(k)));
  if (conflicts.length) return { upstreamHead, upstream, landed, conflicts, remaining };

  let result = upstream;
  for (const op of remaining) {
    try {
      result = applyChangeOps(result, [op], { author, date: clock.iso().slice(0, 10), source: `${p.slug} fork ${f.slug}` }).graph;
    } catch (err) {
      const k = perOp[f.ops.indexOf(op)]?.[0];
      conflicts.push({ iri: k, curie: k ? label(k) : undefined, message: `“${describeOp(op, label)}” no longer applies to the latest draft: ${(err as Error).message}.` });
    }
  }
  // Every edit must come out exactly as it is on the fork.
  if (!conflicts.length)
    for (const k of keys.filter((x) => !landed.includes(x)))
      if (describe(result, k) !== describe(fork, k)) conflicts.push({ iri: k, curie: label(k), message: `${label(k)} would not come out the same on the latest draft as it is in the fork.` });
  return { upstreamHead, upstream, landed, conflicts, remaining, result: conflicts.length ? undefined : result };
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

function requireOwner(f: OntologyFork, user: User | undefined, action: string): asserts user is User {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (f.ownerId !== user.id && !user.isPlatformAdmin) throw new HttpError(403, `Only the fork's owner can ${action}`);
}

function requireOpen(f: OntologyFork) {
  if (f.status === 'closed') throw new HttpError(409, 'This fork is closed. It still resolves, but it no longer changes.');
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
  fork.head = await ontologyStore.commitFork(p, slug, graph, `Fork ${p.title} ${p.currentVersion} as “${name}”${fork.purpose ? `\n\n${fork.purpose}` : ''}`, { name: owner.name, email: owner.email }, { expectedParent: fork.baseCommit });
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

/** Strict OWL: a fork may never serve an inconsistent ontology or an unsatisfiable class. */
async function requireConsistent(p: OntologyProject, graph: OntologyGraph, what: string) {
  const report = await validate(graph, { cqs: competencyTests(p.id), reasoner: 'owl', fair: await fairContext(graph.ontologyIRI) });
  const brief = validationBrief(report);
  if (!brief.consistent) {
    const unsat = report.reasoner.unsatisfiable.map((i) => compactIRI(i, graph.prefixes));
    throw new HttpError(422, `${what} would make the ontology logically inconsistent${unsat.length ? ` (unsatisfiable: ${unsat.join(', ')})` : ''}, so nothing was changed.`);
  }
  return brief;
}

/** Add or change terms on the fork. Refuses edits that would make the ontology inconsistent. */
export async function editFork(fork: OntologyFork, user: User | undefined, input: ForkEditInput): Promise<ForkEditResult> {
  requireOwner(fork, user, 'edit it');
  return locked(fork.id, async (f) => {
    requireOpen(f);
    const p = getProject(f.ontologyId);
    const head = f.head;
    const current = await ontologyStore.forkGraph(p, f.slug);
    if (ontologyStore.forkHead(p, f.slug) !== head) throw new HttpError(409, 'The fork changed while this edit was being prepared. Reload it and try again.');
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
      const r = applyChangeOps(current, ops, { author: user.name, date: clock.iso().slice(0, 10), source: `${p.slug} fork ${f.slug}` });
      after = r.graph;
      warnings = [...warnings, ...r.warnings];
    } catch (err) {
      const msg = err instanceof ChangeOpError ? `Edit ${err.opIndex + 1} cannot be applied: ${err.message}` : (err as Error).message;
      throw new HttpError(400, msg);
    }
    const validation = await requireConsistent(p, after, 'These edits');

    f.revision += 1;
    const subject = (message || input.description?.split('\n')[0] || 'Edit the fork').slice(0, 120);
    f.head = await ontologyStore.commitFork(p, f.slug, stamp(after, p, f), subject, { name: user.name, email: user.email }, { expectedParent: head });
    f.ops = [...f.ops, ...ops];
    save(f);
    logActivity({ ontologyId: p.id, actorId: user.id, type: 'fork.edited', message: `edited the fork “${f.title}”: ${subject}`, link: `/o/${p.slug}/forks/${f.slug}` });
    const summary = await forkSummary(f);
    const edited = new Set(keysPerOp(current, ops).flat());
    return { fork: summary, ops, terms: summary.terms.filter((t) => edited.has(t.iri)), warnings, validation };
  });
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

const conflictText = (c: ForkConflict[]) => c.map((x) => x.message).join(' ');

/**
 * Propose the fork's outstanding edits upstream as one change request, which
 * then follows the ontology's governance policy. Proposing again while that
 * request is open updates its edits (earlier approvals stop counting, as for
 * any edit). Edits that have already landed are left out; conflicts with the
 * latest draft must be resolved first.
 */
export async function proposeFork(fork: OntologyFork, user: User | undefined, input: { title?: string; description?: string } = {}): Promise<{ fork: ForkSummary; changeRequest: ChangeRequest }> {
  requireOwner(fork, user, 'propose it upstream');
  return locked(fork.id, async (f) => {
    requireOpen(f);
    const p = getProject(f.ontologyId);
    const plan = await rebasePlan(p, f, user.name);
    if (plan.conflicts.length) throw new HttpError(409, `Resolve the fork's conflicts with the latest draft first (sync it, then discard or redo the conflicting edits). ${conflictText(plan.conflicts)}`);
    if (!plan.remaining.length) throw new HttpError(409, f.ops.length ? 'Everything in this fork is already in the working draft.' : 'The fork has no edits to propose yet.');

    const c = (iri: string) => keyLabel(iri, plan.upstream.prefixes);
    const keys = [...new Set(keysPerOp(await ontologyStore.graphAt(p, f.baseCommit), plan.remaining).flat())].filter((k) => !plan.landed.includes(k));
    const named = keys.slice(0, 3).map(c).join(', ');
    const title = input.title?.trim() || `${plan.remaining.every((o) => o.op.startsWith('add')) ? 'Add' : 'Change'} ${named}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}`;
    const urls = forkUrls(p, f);
    const description =
      input.description?.trim() ||
      [
        f.purpose ? `Needed for: ${f.purpose}` : undefined,
        `Proposed from the development fork “${f.title}” (${forkVersion(f)}), which is already in use at <${urls.iri}>.`,
        `Terms: ${keys.map(c).join(', ')}.`,
      ]
        .filter(Boolean)
        .join('\n\n');

    if (!rolesFor(p.id, user.id).length) setRoles(p.id, user.id, ['contributor']);
    const existing = openCR(f);
    let cr: ChangeRequest;
    if (existing) {
      cr = await updateOps(existing, user, { ops: plan.remaining, title: input.title?.trim() || undefined, description: input.description?.trim() || undefined });
    } else {
      cr = await createChangeRequest(p, user, { title, description, kind: 'feature', origin: { type: 'fork', forkId: f.id, forkSlug: f.slug }, ops: plan.remaining, submit: true });
      f.changeRequestIds.push(cr.id);
      logActivity({ ontologyId: p.id, actorId: user.id, type: 'fork.proposed', message: `proposed the fork “${f.title}” upstream as #${cr.number}`, link: `/o/${p.slug}/changes/${cr.id}` });
    }
    f.status = 'proposed';
    f.proposedRevision = f.revision;
    save(f);
    return { fork: await forkSummary(f), changeRequest: getCR(cr.id) };
  });
}

/**
 * Bring the fork up to date with upstream: move its base to the latest
 * working draft and replay the edits that haven't landed. Changes nothing if
 * any edit conflicts with what upstream did since (both sides changed the
 * same term), or if the result would be inconsistent.
 */
export async function syncFork(fork: OntologyFork, user: User | undefined): Promise<ForkSyncResult> {
  requireOwner(fork, user, 'sync it');
  return locked(fork.id, async (f) => {
    requireOpen(f);
    const p = getProject(f.ontologyId);
    const behind = ontologyStore.commitsSince(p, f.baseCommit);
    if (!behind) return { synced: false, fork: await forkSummary(f), conflicts: [], message: 'Already up to date with upstream.' };
    const plan = await rebasePlan(p, f, getUser(f.ownerId)?.name);
    if (plan.conflicts.length || !plan.result)
      return {
        synced: false,
        fork: await forkSummary(f),
        conflicts: plan.conflicts,
        message: `Not synced: ${plan.conflicts.length} of this fork's changes conflict with upstream. Discard them (keeping upstream's version), or discard and redo them on the synced fork.`,
      };
    const result = plan.result;
    try {
      await requireConsistent(p, result, 'Syncing');
    } catch (err) {
      return { synced: false, fork: await forkSummary(f), conflicts: [{ message: (err as Error).message.replace('so nothing was changed', 'combined with upstream, so the fork was left as it was') }], message: 'Not synced: the fork and upstream are each consistent, but not together.' };
    }
    const head = f.head;
    const oldBase = f.baseCommit;
    f.revision += 1;
    f.baseCommit = plan.upstreamHead;
    f.baseVersion = p.currentVersion;
    f.ops = plan.remaining;
    if (plan.landed.length) {
      const before = await ontologyStore.graphAt(p, oldBase);
      const fork = await ontologyStore.forkGraph(p, f.slug);
      const landed = new Map((f.landed ?? []).map((l) => [l.key, l]));
      for (const k of plan.landed) if (!landed.has(k)) landed.set(k, { key: k, change: changeKind(describe(before, k), describe(fork, k)) });
      f.landed = [...landed.values()];
    }
    f.head = await ontologyStore.commitFork(p, f.slug, stamp(result, p, f), `Sync with ${p.title} ${p.currentVersion} (${plan.upstreamHead.slice(0, 7)})`, { name: user.name, email: user.email }, { expectedParent: head, extraParents: [plan.upstreamHead] });
    save(f);
    const landed = plan.landed.map((k) => keyLabel(k, result.prefixes));
    return {
      synced: true,
      fork: await forkSummary(f),
      conflicts: [],
      message: `Synced with upstream (${behind} new commit${behind === 1 ? '' : 's'}).${landed.length ? ` Already upstream: ${landed.join(', ')}.` : ''}`,
    };
  });
}

/**
 * Drop the fork's changes to some terms (or all of them), so the fork has
 * upstream's version of those terms as of its base. This is how a conflict is
 * resolved: discard the conflicting change, sync, and redo it if still needed.
 */
export async function discardForkChanges(fork: OntologyFork, user: User | undefined, terms: string[] | 'all') {
  requireOwner(fork, user, 'change it');
  return locked(fork.id, async (f) => {
    requireOpen(f);
    const p = getProject(f.ontologyId);
    const base = await ontologyStore.graphAt(p, f.baseCommit);
    const perOp = keysPerOp(base, f.ops);
    const drop = terms === 'all' ? undefined : new Set(terms.map((t) => toKey(t, base.prefixes)));
    const keep = drop ? f.ops.filter((_, i) => !perOp[i].some((k) => drop.has(k))) : [];
    if (keep.length === f.ops.length) throw new HttpError(400, 'The fork has no changes to those terms.');
    let graph = base;
    try {
      graph = applyChangeOps(base, keep, { author: user.name, date: clock.iso().slice(0, 10), source: `${p.slug} fork ${f.slug}` }).graph;
    } catch (err) {
      throw new HttpError(409, `Other changes in the fork depend on that one, so it can't be discarded on its own (${(err as Error).message}). Discard those too.`);
    }
    await requireConsistent(p, graph, 'Discarding that change');
    const head = f.head;
    const dropped = f.ops.length - keep.length;
    f.revision += 1;
    f.ops = keep;
    f.head = await ontologyStore.commitFork(p, f.slug, stamp(graph, p, f), `Discard ${dropped} change${dropped === 1 ? '' : 's'}${drop ? ` to ${[...drop].map((k) => keyLabel(k, base.prefixes)).join(', ')}` : ''}`, { name: user.name, email: user.email }, { expectedParent: head });
    if (f.status === 'released' || f.status === 'merged') f.status = 'active';
    save(f);
    return forkSummary(f);
  });
}

const changeKind = (before: string, after: string): 'added' | 'changed' | 'removed' => (before === '' ? 'added' : after === '' ? 'removed' : 'changed');

/** A term as the caller names it (IRI, <IRI>, CURIE, or a conflict's key) to a key. */
function toKey(t: string, prefixes: Record<string, string>) {
  const s = t.trim().replace(/^<(.*)>$/, '$1');
  if (s.startsWith('import:') || s.startsWith('meta:') || s.includes('://')) return s;
  const i = s.indexOf(':');
  const ns = i >= 0 ? prefixes[s.slice(0, i)] : undefined;
  return ns ? ns + s.slice(i + 1) : s;
}

export async function closeFork(fork: OntologyFork, user: User | undefined) {
  requireOwner(fork, user, 'close it');
  return locked(fork.id, async (f) => {
    f.status = 'closed';
    save(f);
    logActivity({ ontologyId: f.ontologyId, actorId: user.id, type: 'fork.closed', message: `closed the fork “${f.title}”`, link: `/o/${getProject(f.ontologyId).slug}/forks/${f.slug}` });
    return forkSummary(f);
  });
}

/* ------------------------------------------------------------------------ */
/* Where the fork's changes stand upstream                                   */
/* ------------------------------------------------------------------------ */

async function termStatuses(f: OntologyFork, p: OntologyProject): Promise<ForkTerm[]> {
  const base = await ontologyStore.graphAt(p, f.baseCommit);
  const fork = await ontologyStore.forkGraph(p, f.slug);
  const working = await ontologyStore.working(p);
  const released = p.currentVersion !== '0.0.0' && ontologyStore.versions(p).includes(p.currentVersion) ? await ontologyStore.at(p, p.currentVersion) : undefined;
  const cr = latestCR(f);
  const crOpen = cr && OPEN_CR.includes(cr.status);
  let proposed: OntologyGraph | undefined;
  if (crOpen) {
    try {
      proposed = applyChangeOps(working, cr.ops).graph;
    } catch {
      proposed = undefined;
    }
  }
  const crKeys = new Set(cr ? termsOf(cr.ops, working.namespace).map((t) => t.iri) : []);
  const views = new Map([...termsOf(f.ops, base.namespace)].map((t) => [t.iri, t]));
  const pending = [...new Set(keysPerOp(base, f.ops).flat())];
  const landedChange = new Map((f.landed ?? []).filter((l) => !pending.includes(l.key)).map((l) => [l.key, l.change]));
  const keys = [...pending, ...landedChange.keys()];
  return keys.map((k) => {
    const mine = describe(fork, k);
    const before = describe(base, k);
    const t = k.includes('://') && !k.startsWith('import:') && !k.startsWith('meta:') ? (fork.term(k) ?? base.term(k)) : undefined;
    const term: ForkTerm = {
      iri: k,
      curie: keyLabel(k, working.prefixes),
      label: t?.label ?? views.get(k)?.label,
      kind: t?.kind ?? views.get(k)?.kind ?? (k.startsWith('import:') ? 'import' : k.startsWith('meta:') ? 'metadata' : 'term'),
      change: landedChange.get(k) ?? changeKind(before, mine),
      upstream: 'not-proposed',
    };
    if (released && describe(released, k) === mine) return { ...term, upstream: 'released', releasedIn: p.currentVersion };
    if (describe(working, k) === mine) return { ...term, upstream: 'merged' };
    if (crOpen) {
      if (proposed ? describe(proposed, k) === mine : crKeys.has(k)) return { ...term, upstream: 'pending' };
      // Edited since it was proposed, or not part of the request.
    } else if (cr && (cr.status === 'rejected' || cr.status === 'withdrawn') && crKeys.has(k)) return { ...term, upstream: 'rejected' };
    if (describe(working, k) !== before) return { ...term, upstream: 'diverged' };
    return term;
  });
}

function computeStatus(f: OntologyFork, terms: ForkTerm[]): ForkStatus {
  if (f.status === 'closed') return 'closed';
  if (terms.length && terms.every((t) => t.upstream === 'released')) return 'released';
  if (terms.length && terms.every((t) => t.upstream === 'released' || t.upstream === 'merged')) return 'merged';
  if (openCR(f)) return 'proposed';
  return 'active';
}

export async function forkSummary(f: OntologyFork): Promise<ForkSummary> {
  const p = getProject(f.ontologyId);
  const terms = await termStatuses(f, p);
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
 * it, sync it, resolve conflicts, or move the application back to the main
 * ontology because everything in the fork has landed, exactly as it is in
 * the fork.
 */
export async function checkFork(f: OntologyFork): Promise<ForkCheck> {
  const fork = await forkSummary(f);
  const p = getProject(f.ontologyId);
  const swap = (target: string) => [{ from: fork.urls.iri, to: target }, ...Object.entries(fork.urls.formats).map(([fmt, url]) => ({ from: url, to: `${target}.${FORMAT_INFO[fmt as OutputFormat].extension}` }))];
  const cr = fork.changeRequest;
  const crOpen = cr && OPEN_CR.includes(cr.status);
  const names = (ts: ForkTerm[]) => ts.map((t) => t.curie).join(', ');

  if (fork.status === 'closed') {
    return { fork, outcome: 'fork-closed', message: `The fork “${f.title}” is closed. It still resolves, but it won't change any more.`, replace: [], conflicts: [], steps: ['Move to the latest release, or create a new fork if you still need changes that are not in it.'] };
  }
  if (fork.status === 'released') {
    const target = versionUrl(p, p.currentVersion);
    return {
      fork,
      outcome: 'switch-to-release',
      message: `Everything in “${f.title}” is in ${p.title} ${p.currentVersion}, exactly as in the fork. Switch your imports from the fork to the release.`,
      replace: swap(target),
      conflicts: [],
      steps: [
        `Replace ${fork.urls.iri} with ${target} in your imports (and the same for each file extension).`,
        'Regenerate or re-import any classes or schemas generated from the ontology, then run your tests.',
        `Close the fork once nothing uses it (close_fork, or Close fork on ${fork.urls.app}).`,
      ],
    };
  }
  if (fork.status === 'merged') {
    const draft = versionUrl(p, 'draft');
    return {
      fork,
      outcome: 'switch-to-draft',
      message: `Everything in “${f.title}” is in the ${p.title} working draft, but not released yet. Keep using the fork until the next release, or switch to the draft, which keeps changing until it is released.`,
      replace: swap(draft),
      conflicts: [],
      steps: [`Optional: replace ${fork.urls.iri} with ${draft} now, or wait for the next release and switch to it then.`, 'Check again at the start of your next session.'],
    };
  }

  const steps: string[] = [];
  const landed = fork.terms.filter((t) => t.upstream === 'released' || t.upstream === 'merged');
  const unsent = fork.terms.filter((t) => t.upstream === 'not-proposed');
  const rejected = fork.terms.filter((t) => t.upstream === 'rejected');
  if (landed.length) steps.push(`Already upstream: ${names(landed)}. The rest of the fork has not landed yet, so keep importing the fork.`);
  if (rejected.length && cr) steps.push(`Change request #${cr.number} was ${cr.status}, so ${names(rejected)} did not land. Read the reviewers' comments on it, then edit the fork and propose again, or keep them as a local extension.`);
  if (unsent.length) steps.push(crOpen ? `${names(unsent)} changed since you proposed the fork: call propose_fork again to update change request #${cr!.number}.` : `When you are happy with ${names(unsent)}, propose the fork upstream (propose_fork) so the standard can adopt it.`);
  if (crOpen && !unsent.length) steps.push('Nothing to change in your application. Check again at the start of your next session.');

  if (fork.behindBy > 0) {
    const plan = await rebasePlan(p, f);
    if (plan.conflicts.length) {
      return {
        fork,
        outcome: 'resolve-conflicts',
        message: `Upstream has changed ${plan.conflicts.length === 1 ? 'something' : 'things'} the fork also changes. Keep using the fork for now, and resolve the conflicts before proposing again.`,
        replace: [],
        conflicts: plan.conflicts,
        steps: [
          ...plan.conflicts.map((c) => c.message),
          'For each conflict, discard the fork\'s change (discard_fork_changes) to take upstream\'s version, then sync (sync_fork) and redo the change with edit_fork if you still need it.',
          ...steps,
        ],
      };
    }
    steps.unshift(`Upstream has ${fork.behindBy} new commit${fork.behindBy === 1 ? '' : 's'} since the fork's base${p.currentVersion !== f.baseVersion ? ` (now at ${p.currentVersion})` : ''}. Sync the fork (sync_fork) to pick them up; nothing conflicts.`);
    return { fork, outcome: 'sync-fork', message: `“${f.title}” is behind upstream; sync it to pick up the latest changes.`, replace: [], conflicts: [], steps };
  }
  const why = crOpen ? ` while change request #${cr!.number} is ${CR_STATE[cr!.status]}` : '';
  return { fork, outcome: 'keep-using-fork', message: `Keep using “${f.title}”${why}.`, replace: [], conflicts: [], steps };
}
