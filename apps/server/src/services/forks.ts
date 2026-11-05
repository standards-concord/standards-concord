import { applyChangeOps, canonicalTriples, ChangeOpError, compactIRI, FORMAT_INFO, setMetadata, structuralReasoner, termDescription, validate, type OntologyGraph } from '@concord/core';
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
import { get, HttpError, list, mustGet, put, putIf, withFence } from '../db.js';
import { newId, slugify } from '../ids.js';
import type { ProposedTerm } from '../llm/schemas.js';
import { createChangeRequest, draftFromNaturalLanguage, getCR, submit, updateOps } from './changeRequests.js';
import { reasonInWorker } from '../reasoner/pool.js';
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

/** How long a proposal may hold the fork; one whose process stopped stops blocking the fork after this. */
const PROPOSE_LEASE_MS = 5 * 60_000;

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
/** Header fields the fork stamps itself (stamp()); fork edits may not set them, and they aren't compared. Every other header field is. */
const STAMPED = new Set(['versionIRI', 'versionInfo', 'priorVersion', 'modified']);

type Snapshot = Pick<OntologyFork, 'seq'>;

/**
 * Store a changed fork, only if nobody else has changed it since `from` was
 * read: one conditional UPDATE on the record version (`seq`), which every
 * change advances (closing and proposing included). Atomic across server
 * processes sharing the database. Reads never write, so a slow read can't put
 * back an old version. Returns the new snapshot, for a change saved in steps.
 */
async function save(f: OntologyFork, from: Snapshot): Promise<Snapshot> {
  f.seq = (from.seq ?? 0) + 1;
  f.updatedAt = clock.iso();
  if (!await putIf('forks', f, 'seq', from.seq, f.ontologyId)) throw new HttpError(409, 'The fork changed while this edit was being made. Reload it and try again.');
  return { seq: f.seq };
}

/**
 * Commit to the fork's branch (compare-and-swap on its head), then save the
 * record. If the save loses to a change made elsewhere, the commit is undone,
 * so the branch and the record never disagree.
 */
async function commitAndSave(p: OntologyProject, f: OntologyFork, from: Snapshot, commit: () => Promise<string>): Promise<Snapshot> {
  const before = f.head;
  const head = await commit();
  f.head = head;
  try {
    return await save(f, from);
  } catch (err) {
    ontologyStore.rewindFork(p, f.slug, before, head);
    f.head = before;
    throw err;
  }
}

/** A proposal's writes hold only while the fork record is still at the version its lease was saved with. */
function proposalFence(id: string, claimed: Snapshot) {
  return async () => {
    if ((await get<OntologyFork>('forks', id))?.seq !== claimed.seq)
      throw new HttpError(409, 'The fork changed while it was being proposed (this proposal took too long and lost its hold on the fork). Reload it and propose again if needed.');
  };
}

/** Internals exercised by the concurrency tests. */
export const forTests = { save, commitAndSave, proposalFence };

export const listForks = async (ontologyId: string) => (await list<OntologyFork>('forks', ontologyId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
export const forksOwnedBy = async (userId: string) => (await list<OntologyFork>('forks')).filter((f) => f.ownerId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** A fork by id (frk_…), "<ontology>/<fork-slug>", or a fork slug within `project`. */
export async function findFork(ref: string, project?: OntologyProject): Promise<OntologyFork | undefined> {
  const byId = await get<OntologyFork>('forks', ref);
  if (byId) return byId;
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const p = await findProject(ref.slice(0, slash));
    return p ? (await listForks(p.id)).find((f) => f.slug === ref.slice(slash + 1)) : undefined;
  }
  if (project) return (await listForks(project.id)).find((f) => f.slug === ref);
  const matches = (await list<OntologyFork>('forks')).filter((f) => f.slug === ref);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function mustFindFork(ref: string, project?: OntologyProject): Promise<OntologyFork> {
  const f = await findFork(ref, project);
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
async function locked<T>(id: string, fn: (f: OntologyFork, from: Snapshot) => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      const f = await mustGet<OntologyFork>('forks', id);
      if (f.proposing && f.proposing.until > Date.now()) throw new HttpError(409, 'The fork is being proposed upstream right now. Try again in a moment.');
      delete f.proposing; // a lease that ran out (its process stopped) no longer holds anything
      return fn(f, { seq: f.seq });
    });
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
const URL_FORMATS: OutputFormat[] = ['turtle', 'jsonld', 'rdfxml', 'ntriples', 'manchester', 'linkml', 'shacl', 'shaclc', 'javascript', 'typescript'];

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

/** The fork document's own version metadata, so tools can tell it apart from a release. (Not an edit: `modified` is refused in edits.) */
function stamp(graph: OntologyGraph, p: OntologyProject, f: OntologyFork): OntologyGraph {
  const g = graph.clone();
  setMetadata(g, {
    versionIRI: forkUrls(p, f).iri,
    versionInfo: forkVersion(f),
    ...(f.baseVersion !== '0.0.0' ? { priorVersion: releaseVersionIRI(p, f.baseVersion) } : {}),
    modified: clock.iso().slice(0, 10),
  });
  return g;
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

/** A CURIE or IRI as the graph stores it. */
function expand(iri: string, prefixes: Record<string, string>) {
  const s = iri.trim().replace(/^<(.*)>$/, '$1');
  if (s.includes('://') || s.startsWith('urn:')) return s;
  const i = s.indexOf(':');
  const ns = i >= 0 ? prefixes[s.slice(0, i)] : undefined;
  return ns ? ns + s.slice(i + 1) : s;
}

/** The keys each edit touches, by applying the edits one at a time on the graph they were made against. */
function keysPerOp(base: OntologyGraph, ops: ChangeOp[]): string[][] {
  let g = base;
  return ops.map((op) => {
    const keys = new Set<string>();
    if (op.op === 'addImport') keys.add(`import:${expand(op.iri, g.prefixes)}`);
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

interface Outstanding {
  /** The edits that still make a difference, in order. */
  ops: ChangeOp[];
  perOp: string[][];
  /** Keys the fork has changed relative to its base (not ones it changed and changed back). */
  keys: string[];
}

/**
 * One header edit per field, so a field changed and changed back cancels out
 * on its own. Fields the fork stamps itself are dropped: stamp() overwrites
 * them in the fork, so they never had an effect there, and must not travel
 * upstream in a proposal (edits stored before they were refused included).
 */
function splitHeaderEdits(ops: ChangeOp[]): ChangeOp[] {
  return ops.flatMap((op) =>
    op.op === 'setMetadata' ? Object.entries(op.set).filter(([field]) => !STAMPED.has(field)).map(([field, value]) => ({ op: 'setMetadata', set: { [field]: value } }) as ChangeOp) : [op],
  );
}

/**
 * The fork's edits that still make a difference to its base. Edits whose
 * every key is back to its base content (a definition changed and restored,
 * a class added and removed) are dropped, as long as the rest still rebuild
 * the fork exactly; otherwise all edits are kept.
 */
function outstanding(base: OntologyGraph, fork: OntologyGraph, edits: ChangeOp[]): Outstanding {
  const ops = splitHeaderEdits(edits);
  const perOp = keysPerOp(base, ops);
  const all = [...new Set(perOp.flat())];
  const changed = all.filter((k) => describe(base, k) !== describe(fork, k));
  if (changed.length === all.length) return { ops, perOp, keys: changed };
  const keep = ops.map((_, i) => !perOp[i].length || perOp[i].some((k) => changed.includes(k)));
  const pruned = ops.filter((_, i) => keep[i]);
  try {
    const rebuilt = applyChangeOps(base, pruned).graph;
    if (all.every((k) => describe(rebuilt, k) === describe(fork, k))) return { ops: pruned, perOp: perOp.filter((_, i) => keep[i]), keys: changed };
  } catch {
    // A kept edit depended on a dropped one: keep everything.
  }
  return { ops, perOp, keys: changed };
}

/**
 * Terms whose content differs between two graphs, from a full triple
 * comparison: named subjects of changed triples, and the terms mentioned by
 * changed anonymous axioms, as term keys; header fields and imports as
 * meta:/import: keys. Engine-stamped provenance is left out.
 */
function changedTerms(a: OntologyGraph, b: OntologyGraph): string[] {
  const la = canonicalTriples(a.store);
  const lb = canonicalTriples(b.store);
  const out = new Set<string>();
  const header = a.ontologyIRI || b.ontologyIRI;
  const visit = (line: string) => {
    const named = /^<([^>]+)> <([^>]+)> /.exec(line);
    if (named) {
      // Engine-stamped provenance, and the declarations of the properties it uses.
      const stampedBy = /^http:\/\/purl\.org\/dc\/terms\/(created|modified|contributor|provenance)$/;
      const generated = stampedBy.test(named[2]) || stampedBy.test(named[1]);
      if (named[1] !== header && !generated) out.add(named[1]);
      return;
    }
    for (const m of line.matchAll(/<([^>]+)>/g)) if (m[1] !== header && (a.term(m[1]) || b.term(m[1]))) out.add(m[1]);
  };
  for (const l of la) if (!lb.has(l)) visit(l);
  for (const l of lb) if (!la.has(l)) visit(l);
  // The header is compared field by field, as the fork's edits to it are keyed.
  const ma = a.metadata() as unknown as Record<string, unknown>;
  const mb = b.metadata() as unknown as Record<string, unknown>;
  for (const field of new Set([...Object.keys(ma), ...Object.keys(mb)]))
    if (field !== 'iri' && field !== 'imports' && !STAMPED.has(field) && JSON.stringify(ma[field] ?? null) !== JSON.stringify(mb[field] ?? null)) out.add(`meta:${field}`);
  const ia = a.metadata().imports;
  const ib = b.metadata().imports;
  for (const i of ia) if (!ib.includes(i)) out.add(`import:${i}`);
  for (const i of ib) if (!ia.includes(i)) out.add(`import:${i}`);
  return [...out];
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
  const out = outstanding(base, fork, f.ops);
  const landed: string[] = [];
  const conflicts: ForkConflict[] = [];
  for (const k of out.keys) {
    const mine = describe(fork, k);
    const theirs = describe(upstream, k);
    if (theirs === mine) landed.push(k);
    else if (theirs !== describe(base, k))
      conflicts.push({ iri: k, curie: label(k), message: `${label(k)} has changed upstream since this fork was last synced, and not in the same way as in the fork.`, discard: [k], discardLabels: [label(k)] });
  }
  // Every edit still needed: all but those whose every key has landed. (Edits outstanding() had
  // to keep for an unchanged key stay too: the fork is only reproduced with them.)
  const remaining = out.ops.filter((_, i) => !out.perOp[i].length || out.perOp[i].some((k) => !landed.includes(k)));
  const keysOf = (op: ChangeOp) => out.perOp[out.ops.indexOf(op)] ?? [];
  if (conflicts.length) return { upstreamHead, upstream, landed, conflicts, remaining };

  let result = upstream;
  const states = [upstream];
  for (const op of remaining) {
    try {
      result = applyChangeOps(result, [op], { author, date: clock.iso().slice(0, 10), provenance: `${p.slug} fork ${f.slug}` }).graph;
    } catch (err) {
      const k = keysOf(op)[0];
      conflicts.push({ iri: k, curie: k ? label(k) : undefined, message: `“${describeOp(op, label)}” no longer applies to the latest draft: ${(err as Error).message}.`, discard: keysOf(op), discardLabels: keysOf(op).map(label) });
    }
    states.push(result);
  }
  /** The keys of the edit whose replay changed `k`: what to discard to resolve a conflict on it. */
  const cause = (k: string) => {
    for (let i = 0; i < remaining.length; i++) if (describe(states[i], k) !== describe(states[i + 1], k)) return keysOf(remaining[i]);
    return [k];
  };
  if (!conflicts.length) {
    // Every term the replay changes, including ones the edits only reach indirectly (removing a
    // class also removes the subclass axioms that point at it), must come out exactly as in the
    // fork, and upstream must not have changed it in the meantime.
    const pending = out.keys.filter((x) => !landed.includes(x));
    const reached = new Set([...pending, ...changedTerms(upstream, result)]);
    for (const k of reached) {
      if (landed.includes(k)) continue;
      const asFork = describe(result, k) === describe(fork, k);
      const upstreamChanged = describe(upstream, k) !== describe(base, k);
      if (pending.includes(k) ? !asFork : !asFork || upstreamChanged) {
        const discard = pending.includes(k) ? [k] : cause(k);
        conflicts.push({
          iri: k,
          curie: label(k),
          discard,
          discardLabels: discard.map(label),
          message: pending.includes(k)
            ? `${label(k)} would not come out the same on the latest draft as it is in the fork.`
            : `Replaying the fork's change to ${discard.map(label).join(', ')} would also change ${label(k)}, which ${upstreamChanged ? 'has changed upstream since this fork was last synced' : 'the fork does not change'}.`,
        });
      }
    }
  }
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
  // Forks record generated provenance as dcterms:provenance (format 2). Earlier ones mixed it into
  // dcterms:source, which can't be told apart from sources people asked for, so they aren't converted.
  if (f.provenanceFormat !== 2)
    throw new HttpError(409, 'This fork was made by an earlier version of Concord and can no longer be changed. It still resolves; create a new fork, redo its changes there, and close this one.');
}

async function uniqueForkSlug(ontologyId: string, base: string) {
  const taken = new Set((await listForks(ontologyId)).map((f) => f.slug));
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

export async function createFork(p: OntologyProject, owner: User, input: { name: string; purpose?: string }): Promise<OntologyFork> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'Give the fork a name');
  const slug = await uniqueForkSlug(p.id, slugify(name).replace(/^-+|-+$/g, '') || 'fork');
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
    provenanceFormat: 2,
    createdAt: now,
    updatedAt: now,
  };
  fork.baseCommit = ontologyStore.createFork(p, slug);
  const graph = stamp(await ontologyStore.working(p), p, fork);
  fork.head = await ontologyStore.commitFork(p, slug, graph, `Fork ${p.title} ${p.currentVersion} as “${name}”${fork.purpose ? `\n\n${fork.purpose}` : ''}`, { name: owner.name, email: owner.email }, { expectedParent: fork.baseCommit });
  fork.seq = 1;
  await put('forks', fork, fork.ontologyId);
  await logActivity({ ontologyId: p.id, actorId: owner.id, type: 'fork.created', message: `forked ${p.title} as “${name}”`, link: `/o/${p.slug}/forks/${slug}` });
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
  validation: Pick<ValidationReport, 'passed'> & { reasoner: 'owl' | 'structural'; consistent: boolean; errors: string[]; warnings: string[] };
}

function validationBrief(v: ValidationReport) {
  return {
    passed: v.passed,
    reasoner: v.reasoner.available ? ('owl' as const) : ('structural' as const),
    consistent: v.reasoner.consistent && v.reasoner.unsatisfiable.length === 0,
    errors: v.lint.filter((i) => i.severity === 'error').map((i) => i.message),
    warnings: v.lint.filter((i) => i.severity === 'warning').map((i) => i.message),
  };
}

/** Strict OWL: a fork may never serve an inconsistent ontology or an unsatisfiable class. */
async function requireConsistent(p: OntologyProject, graph: OntologyGraph, what: string) {
  const report = await validate(graph, { cqs: await competencyTests(p.id), reasoner: 'owl', owlReasoner: reasonInWorker, fair: await fairContext(graph.ontologyIRI) });
  const brief = validationBrief(report);
  if (!report.reasoner.available) {
    // The fallback structural check misses whole classes of inconsistency (cardinalities, for one).
    if (config.requireFullReasoner)
      throw new HttpError(503, `The OWL reasoner gave no verdict (${report.reasoner.error ?? 'unknown error'}), so ${what.toLowerCase()} can't be checked for consistency. Nothing was changed. If it was busy or timed out, try again shortly.`);
    // A no-verdict result claims nothing about consistency (the worker's says "consistent", vacuously), so the
    // structural check runs here instead and decides.
    const error = report.reasoner.error;
    report.reasoner = { ...structuralReasoner(graph), available: false, error };
    brief.consistent = report.reasoner.consistent && report.reasoner.unsatisfiable.length === 0;
    brief.warnings.unshift(`Checked with the structural reasoner only: the full OWL reasoner gave no verdict (${error ?? 'unknown error'}).`);
  }
  if (!brief.consistent) {
    const unsat = report.reasoner.unsatisfiable.map((i) => compactIRI(i, graph.prefixes));
    throw new HttpError(422, `${what} would make the ontology logically inconsistent${unsat.length ? ` (unsatisfiable: ${unsat.join(', ')})` : ''}, so nothing was changed.`);
  }
  return brief;
}

/** Add or change terms on the fork. Refuses edits that would make the ontology inconsistent. */
export async function editFork(fork: OntologyFork, user: User | undefined, input: ForkEditInput): Promise<ForkEditResult> {
  requireOwner(fork, user, 'edit it');
  return locked(fork.id, async (f, from) => {
    requireOpen(f);
    const p = await getProject(f.ontologyId);
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
    const own = [...new Set(ops.flatMap((o) => (o.op === 'setMetadata' ? Object.keys(o.set).filter((k) => STAMPED.has(k)) : [])))];
    if (own.length) throw new HttpError(400, `The fork sets its own ${own.join(', ')}, which identify it as a fork version; they can't be edited on a fork. Change them on the main ontology with a change request.`);

    let after: OntologyGraph;
    try {
      const r = applyChangeOps(current, ops, { author: user.name, date: clock.iso().slice(0, 10), provenance: `${p.slug} fork ${f.slug}` });
      after = r.graph;
      warnings = [...warnings, ...r.warnings];
    } catch (err) {
      const msg = err instanceof ChangeOpError ? `Edit ${err.opIndex + 1} cannot be applied: ${err.message}` : (err as Error).message;
      throw new HttpError(400, msg);
    }
    const validation = await requireConsistent(p, after, 'These edits');

    f.revision += 1;
    const subject = (message || input.description?.split('\n')[0] || 'Edit the fork').slice(0, 120);
    // Keep only the edits that still make a difference (an edit undone later drops out).
    f.ops = outstanding(await ontologyStore.graphAt(p, f.baseCommit), after, [...f.ops, ...ops]).ops;
    await commitAndSave(p, f, from, async () => await ontologyStore.commitFork(p, f.slug, stamp(after, p, f), subject, { name: user.name, email: user.email }, { expectedParent: head }));
    await logActivity({ ontologyId: p.id, actorId: user.id, type: 'fork.edited', message: `edited the fork “${f.title}”: ${subject}`, link: `/o/${p.slug}/forks/${f.slug}` });
    const summary = await forkSummary(f);
    const edited = new Set(keysPerOp(current, ops).flat());
    return { fork: summary, ops, terms: summary.terms.filter((t) => edited.has(t.iri)), warnings, validation };
  });
}

/**
 * The fork's change requests, oldest first: those recorded on it, and any
 * request made from it (origin.forkId) that a proposal interrupted before it
 * could record it (its process stopped, or it lost its lease). So a request
 * is never orphaned, and proposing again picks it up instead of opening
 * another.
 */
async function forkCRs(f: OntologyFork): Promise<ChangeRequest[]> {
  const out = new Map<string, ChangeRequest>();
  for (const id of f.changeRequestIds) {
    const cr = await get<ChangeRequest>('changeRequests', id);
    if (cr) out.set(cr.id, cr);
  }
  for (const cr of await list<ChangeRequest>('changeRequests', f.ontologyId)) if (cr.origin.type === 'fork' && cr.origin.forkId === f.id) out.set(cr.id, cr);
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/** The open change request a fork has upstream, if any. */
const openCR = async (f: OntologyFork) => (await forkCRs(f)).findLast((cr) => OPEN_CR.includes(cr.status));
const latestCR = async (f: OntologyFork) => (await forkCRs(f)).at(-1);

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
  return locked(fork.id, async (f, from) => {
    requireOpen(f);
    const p = await getProject(f.ontologyId);
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

    // Take a lease on the fork first (a conditional save), so no edit, sync, close or other
    // proposal, in this process or another, starts while the change request is being made.
    f.proposing = { until: Date.now() + PROPOSE_LEASE_MS };
    const claimed = await save(f, from);
    // Every write to the change request is fenced on that lease: if it runs out (this process
    // stalled) and anything else changes the fork, this proposal's writes are refused, so it can
    // never overwrite newer work. Nothing is ever rolled back.
    const fence = proposalFence(f.id, claimed);
    const release = async () => {
      // Give the lease back if nothing else has changed the fork since.
      const cur = await get<OntologyFork>('forks', f.id);
      if (cur && cur.seq === claimed.seq && cur.proposing) {
        delete cur.proposing;
        try {
          await save(cur, claimed);
        } catch {
          // Changed in the meantime: the lease is no longer this proposal's to give back.
        }
      }
    };
    if (!(await rolesFor(p.id, user.id)).length) await setRoles(p.id, user.id, ['contributor']);
    // An open request from this fork, including one an interrupted proposal created but never
    // recorded on the fork: it is updated, not duplicated.
    const existing = await openCR(f);
    let cr: ChangeRequest;
    try {
      cr = await withFence(fence, async () => {
        if (!existing) return await createChangeRequest(p, user, { title, description, kind: 'feature', origin: { type: 'fork', forkId: f.id, forkSlug: f.slug }, ops: plan.remaining, submit: true });
        const updated = await updateOps(existing, user, { ops: plan.remaining, title: input.title?.trim() || undefined, description: input.description?.trim() || undefined });
        // Interrupted before it was submitted: submit it now.
        return updated.status === 'draft' ? submit(updated, user) : updated;
      });
    } catch (err) {
      await release();
      throw err;
    }
    if (!f.changeRequestIds.includes(cr.id)) f.changeRequestIds.push(cr.id);
    f.status = 'proposed';
    f.proposedRevision = f.revision;
    delete f.proposing;
    // Can only fail if the lease ran out and something else changed the fork after the request
    // was written; the request stays linked to the fork through its origin either way.
    await save(f, claimed);
    if (!existing) await logActivity({ ontologyId: p.id, actorId: user.id, type: 'fork.proposed', message: `proposed the fork “${f.title}” upstream as #${cr.number}`, link: `/o/${p.slug}/changes/${cr.id}` });
    return { fork: await forkSummary(f), changeRequest: await getCR(cr.id) };
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
  return locked(fork.id, async (f, from) => {
    requireOpen(f);
    const p = await getProject(f.ontologyId);
    const behind = ontologyStore.commitsSince(p, f.baseCommit);
    if (!behind) return { synced: false, fork: await forkSummary(f), conflicts: [], message: 'Already up to date with upstream.' };
    const plan = await rebasePlan(p, f, (await getUser(f.ownerId))?.name);
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
      // Only an actual inconsistency is a sync result; anything else (the reasoner being down) is an error.
      if (!(err instanceof HttpError) || err.status !== 422) throw err;
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
    await commitAndSave(p, f, from, async () =>
      await ontologyStore.commitFork(p, f.slug, stamp(result, p, f), `Sync with ${p.title} ${p.currentVersion} (${plan.upstreamHead.slice(0, 7)})`, { name: user.name, email: user.email }, { expectedParent: head, extraParents: [plan.upstreamHead] }),
    );
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
 *
 * Only the named terms change. Header edits are split by field; an edit that
 * also changed other terms (a disjointness between two classes, say) is only
 * dropped with `includeRelated`, and otherwise the refusal lists those terms.
 */
export async function discardForkChanges(fork: OntologyFork, user: User | undefined, terms: string[] | 'all', opts: { includeRelated?: boolean } = {}) {
  requireOwner(fork, user, 'change it');
  return locked(fork.id, async (f, from) => {
    requireOpen(f);
    const p = await getProject(f.ontologyId);
    const base = await ontologyStore.graphAt(p, f.baseCommit);
    const out = outstanding(base, await ontologyStore.forkGraph(p, f.slug), f.ops);
    const drop = terms === 'all' ? undefined : new Set(terms.map((t) => toKey(t, base.prefixes)));
    const label = (k: string) => keyLabel(k, base.prefixes);
    const keep: ChangeOp[] = [];
    const related = new Set<string>();
    // Everything: every stored edit goes, including ones with nothing left to replay (such as a
    // setter of a field the fork stamps itself, stored before those were refused).
    let touched = drop ? 0 : f.ops.length;
    out.ops.forEach((op, i) => {
      if (!drop) return;
      const keys = out.perOp[i];
      const hit = keys.filter((k) => drop.has(k));
      if (!hit.length) return void keep.push(op);
      touched++;
      if (op.op === 'setMetadata') {
        const set = { ...op.set } as Record<string, unknown>;
        for (const k of hit) delete set[k.slice('meta:'.length)];
        if (Object.keys(set).some((field) => !STAMPED.has(field))) keep.push({ ...op, set } as ChangeOp);
        return;
      }
      for (const k of keys) if (!drop.has(k)) related.add(k);
    });
    if (!touched) throw new HttpError(400, drop ? 'The fork has no changes to those terms.' : 'The fork has no changes to discard.');
    if (related.size && !opts.includeRelated)
      throw new HttpError(
        409,
        `The same edit also changed ${[...related].map(label).join(', ')}, so discarding it would discard those changes too. Discard them as well (includeRelated), or leave this change.`,
      );
    let graph = base;
    try {
      graph = applyChangeOps(base, keep, { author: user.name, date: clock.iso().slice(0, 10), provenance: `${p.slug} fork ${f.slug}` }).graph;
    } catch (err) {
      throw new HttpError(409, `Other changes in the fork depend on that one, so it can't be discarded on its own (${(err as Error).message}). Discard those too.`);
    }
    await requireConsistent(p, graph, 'Discarding that change');
    const named = drop ? [...drop, ...related].map(label).join(', ') : 'everything';
    f.revision += 1;
    f.ops = keep;
    const head = f.head;
    await commitAndSave(p, f, from, async () => await ontologyStore.commitFork(p, f.slug, stamp(graph, p, f), `Discard the fork's changes to ${named}`, { name: user.name, email: user.email }, { expectedParent: head }));
    return forkSummary(f);
  });
}

const changeKind = (before: string, after: string): 'added' | 'changed' | 'removed' => (before === '' ? 'added' : after === '' ? 'removed' : 'changed');

/** A term as the caller names it (IRI, <IRI>, CURIE, or a conflict's key) to a key. */
function toKey(t: string, prefixes: Record<string, string>) {
  const s = t.trim();
  if (s.startsWith('import:')) return `import:${expand(s.slice(7), prefixes)}`;
  if (s.startsWith('meta:')) return s;
  return expand(s, prefixes);
}

export async function closeFork(fork: OntologyFork, user: User | undefined) {
  requireOwner(fork, user, 'close it');
  return locked(fork.id, async (f, from) => {
    if (f.status === 'closed') throw new HttpError(409, 'This fork is already closed.');
    const p = await getProject(f.ontologyId);
    // Closing moves the branch too, so an edit prepared before the close (here or in
    // another server process) fails its compare-and-swap instead of reopening the fork.
    const graph = await ontologyStore.forkGraph(p, f.slug);
    const head = f.head;
    f.status = 'closed';
    await commitAndSave(p, f, from, async () => await ontologyStore.commitFork(p, f.slug, graph, 'Close the fork', { name: user.name, email: user.email }, { expectedParent: head }));
    await logActivity({ ontologyId: f.ontologyId, actorId: user.id, type: 'fork.closed', message: `closed the fork “${f.title}”`, link: `/o/${p.slug}/forks/${f.slug}` });
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
  const cr = await latestCR(f);
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
  const pending = outstanding(base, fork, f.ops).keys;
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

async function computeStatus(f: OntologyFork, terms: ForkTerm[]): Promise<ForkStatus> {
  if (f.status === 'closed') return 'closed';
  if (terms.length && terms.every((t) => t.upstream === 'released')) return 'released';
  if (terms.length && terms.every((t) => t.upstream === 'released' || t.upstream === 'merged')) return 'merged';
  if (await openCR(f)) return 'proposed';
  return 'active';
}

export async function forkSummary(f: OntologyFork): Promise<ForkSummary> {
  const p = await getProject(f.ontologyId);
  const terms = await termStatuses(f, p);
  // Derived on every read and never written back, so a slow read can't overwrite a newer edit.
  const status = await computeStatus(f, terms);
  const cr = await latestCR(f);
  return {
    ...f,
    changeRequestIds: (await forkCRs(f)).map((c) => c.id),
    status,
    owner: publicUser(await getUser(f.ownerId)),
    ontology: { id: p.id, slug: p.slug, title: p.title, prefix: p.prefix, currentVersion: p.currentVersion },
    version: forkVersion(f),
    urls: forkUrls(p, f),
    terms,
    changeRequest: cr ? { id: cr.id, number: cr.number, title: cr.title, status: cr.status, level: cr.classification?.level } : undefined,
    behindBy: ontologyStore.commitsSince(p, f.baseCommit),
  };
}

export async function forkDetail(f: OntologyFork) {
  const p = await getProject(f.ontologyId);
  return { ...(await forkSummary(f)), history: ontologyStore.forkLog(p, f.slug, 30) };
}

/**
 * What the fork has that the current release and the working draft don't have
 * exactly the same way: the keys an application importing the fork would lose
 * or see change by switching to them. That includes content the fork only
 * inherited (unreleased draft terms it was created with, or a term upstream
 * has since removed): switching is only offered when the target says
 * everything the fork says. Terms only the target has don't count, nor do
 * header fields other than imports.
 */
async function notIn(p: OntologyProject, f: OntologyFork): Promise<{ release: string[]; draft: string[]; prefixes: Record<string, string> }> {
  const fork = await ontologyStore.forkGraph(p, f.slug);
  const working = await ontologyStore.working(p);
  const lacking = (target: OntologyGraph) =>
    changedTerms(target, fork).filter((k) => !k.startsWith('meta:') && describe(fork, k) !== '' && describe(fork, k) !== describe(target, k));
  const released = p.currentVersion !== '0.0.0' && ontologyStore.versions(p).includes(p.currentVersion) ? await ontologyStore.at(p, p.currentVersion) : undefined;
  return { release: released ? lacking(released) : [], draft: lacking(working), prefixes: working.prefixes };
}

/**
 * What to do about a fork at the start of a development session: keep using
 * it, sync it, resolve conflicts, or move the application back to the main
 * ontology because everything in the fork has landed, exactly as it is in
 * the fork.
 */
export async function checkFork(f: OntologyFork): Promise<ForkCheck> {
  const fork = await forkSummary(f);
  const p = await getProject(f.ontologyId);
  // Version IRIs give their documentation page to clients that don't ask for RDF; the fork IRI gave Turtle.
  const wildcard = (target: string) =>
    `If your code fetches ${fork.urls.iri} without asking for an RDF format (fetch or curl with no Accept header), switch it to ${target}.ttl rather than ${target}: the version IRI answers such requests with its HTML page, where the fork IRI answered with Turtle. RDF tools that send an Accept header can use ${target} as it is.`;
  const swap = (target: string) => [{ from: fork.urls.iri, to: target }, ...Object.entries(fork.urls.formats).map(([fmt, url]) => ({ from: url, to: `${target}.${FORMAT_INFO[fmt as OutputFormat].extension}` }))];
  const cr = fork.changeRequest;
  const crOpen = cr && OPEN_CR.includes(cr.status);
  const names = (ts: ForkTerm[]) => ts.map((t) => t.curie).join(', ');

  if (fork.status === 'closed') {
    return { fork, outcome: 'fork-closed', message: `The fork “${f.title}” is closed. It still resolves, but it won't change any more.`, replace: [], conflicts: [], steps: ['Move to the latest release, or create a new fork if you still need changes that are not in it.'] };
  }
  // Everything the fork changed has landed; the target must also have everything else the
  // application gets from the fork, such as unreleased draft terms the fork was created with.
  const lacking = fork.status === 'released' || fork.status === 'merged' ? await notIn(p, f) : undefined;
  // A fork from before generated provenance had its own property can't be changed (requireOpen),
  // so the only advice that works for it is moving to a target, or recreating it.
  const switchable = (fork.status === 'released' && !lacking?.release.length) || (fork.status === 'merged' && !lacking?.draft.length);
  if (f.provenanceFormat !== 2 && !switchable) {
    const own = fork.terms.length ? ` Its changes: ${names(fork.terms)}.` : '';
    return {
      fork,
      outcome: 'recreate-fork',
      message: `“${f.title}” was made by an earlier version of Concord and can no longer be changed, synced or proposed. It still resolves, so your application keeps working. To carry on developing, recreate it.${own}`,
      replace: [],
      conflicts: [],
      steps: [
        `Create a new fork of ${p.title} (create_fork, or New fork on the Forks page).`,
        `Redo this fork's changes in the new fork with edit_fork${fork.terms.length ? ` (${names(fork.terms)})` : ''}; get_fork on this fork lists them.`,
        `Replace ${fork.urls.iri} with the new fork's IRI in your imports (and the same for each file extension).`,
        `Close this fork once nothing uses it (close_fork, or Close fork on ${fork.urls.app}).`,
      ],
    };
  }
  if (fork.status === 'released' && lacking?.release.length) {
    const draft = versionUrl(p, 'draft');
    const what = lacking.release.map((k) => keyLabel(k, lacking.prefixes)).join(', ');
    const draftOk = !lacking.draft.length;
    return {
      fork,
      outcome: draftOk ? 'switch-to-draft' : 'keep-using-fork',
      message: `The fork's own changes are in ${p.title} ${p.currentVersion}, but ${p.currentVersion} doesn't have ${what} exactly as the fork does (draft content the fork was created with, for example), so switching would change them for your application. ${draftOk ? 'Keep using the fork until the next release, or switch to the draft.' : 'Keep using the fork.'}`,
      replace: draftOk ? swap(draft) : [],
      conflicts: [],
      steps: draftOk
        ? [`Optional: replace ${fork.urls.iri} with ${draft} now, or wait for the release that includes ${what} and switch to it then.`, wildcard(draft), 'Check again at the start of your next session.']
        : [`Neither the release nor the draft has ${lacking.draft.map((k) => keyLabel(k, lacking.prefixes)).join(', ')} as the fork does; sync the fork (sync_fork) and check again.`],
    };
  }
  if (fork.status === 'merged' && lacking?.draft.length) {
    const what = lacking.draft.map((k) => keyLabel(k, lacking.prefixes)).join(', ');
    return {
      fork,
      outcome: 'keep-using-fork',
      message: `The fork's own changes are in the ${p.title} working draft, but the draft doesn't have ${what} as the fork does. Keep using the fork.`,
      replace: [],
      conflicts: [],
      steps: [`Sync the fork (sync_fork) and check again; until then, switching would change ${what} for your application.`],
    };
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
        wildcard(target),
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
      steps: [`Optional: replace ${fork.urls.iri} with ${draft} now, or wait for the next release and switch to it then.`, wildcard(draft), 'Check again at the start of your next session.'],
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
