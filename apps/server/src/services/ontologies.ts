import { OntologyGraph, validate, type OntologyGraph as Graph } from '@concord/core';
import type { ValidationReport } from '@concord/core/types';
import { fairContext } from './fairResolution.js';
import type {
  ChangeRequest,
  GovernancePolicy,
  GovernanceTemplateId,
  Membership,
  OntologyProject,
  OntologySummary,
  Release,
  Role,
  UseCase,
  User,
} from '@concord/shared';
import { SAMPLE_VOCABULARIES } from '@concord/shared';
import { config } from '../config.js';
import { clock } from '../clock.js';
import { checkFence, transaction, get, HttpError, list, mustGet, put, remove } from '../db.js';
import { newId, slugify } from '../ids.js';
import { template } from './governance.js';
import { ontologyStore } from './ontologyStore.js';
import { createHash } from 'node:crypto';
import { getUser, logActivity } from './users.js';
import { reasonInWorker } from '../reasoner/pool.js';
import { filterAsync } from '../asyncList.js';
import { closureFingerprint, hostedImportClosure } from './importClosure.js';

export const getProject = async (id: string) => await mustGet<OntologyProject>('ontologies', id);
export const findProject = async (idOrSlug: string) =>
  await get<OntologyProject>('ontologies', idOrSlug) ?? (await list<OntologyProject>('ontologies')).find((o) => o.slug === idOrSlug);
export const mustFindProject = async (idOrSlug: string) => {
  const p = await findProject(idOrSlug);
  if (!p) throw new HttpError(404, `Ontology ${idOrSlug} not found`);
  return p;
};

export const members = async (ontologyId: string) => await list<Membership>('memberships', ontologyId);
export const rolesFor = async (ontologyId: string, userId: string | undefined): Promise<Role[]> =>
  userId ? ((await get<Membership>('memberships', `${ontologyId}:${userId}`))?.roles ?? []) : [];

const GROUP_ROLES: Role[] = ['owner', 'steward', 'editor', 'reviewer', 'member', 'odi'];
/** Working group members: anyone with a role beyond contributor or agent. */
export const isGroupMember = async (ontologyId: string, user?: User) => !!user && (user.isPlatformAdmin || (await rolesFor(ontologyId, user.id)).some((r) => GROUP_ROLES.includes(r)));

export async function setRoles(ontologyId: string, userId: string, roles: Role[]): Promise<Membership> { return transaction(async () => {
  const id = `${ontologyId}:${userId}`;
  const existing = await get<Membership & { id: string }>('memberships', id);
  const m = { id, ontologyId, userId, roles: [...new Set(roles)], addedAt: existing?.addedAt ?? clock.iso() };
  await put('memberships', m, ontologyId);
  return m;
}); }
export async function removeMember(ontologyId: string, userId: string) {
  await remove('memberships', `${ontologyId}:${userId}`);
}

export async function requireRole(ontologyId: string, user: User | undefined, roles: Role[], action: string) {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (user.isPlatformAdmin) return;
  const have = await rolesFor(ontologyId, user.id);
  if (!have.some((r) => roles.includes(r))) throw new HttpError(403, `Only ${roles.join(' / ')} can ${action}`);
}

export class SlugConflictError extends HttpError {
  constructor(slug: string) { super(409, `An ontology with slug ${slug} already exists`); }
}

export async function createProject(
  input: {
    title: string;
    description: string;
    prefix: string;
    namespace?: string;
    domain?: string;
    governanceTemplate?: GovernanceTemplateId;
    /** List the owner as dct:creator, which is public on the ontology's page. Only when they ask. */
    creditCreator?: boolean;
    seedTurtle?: string;
    demo?: boolean;
    sample?: OntologyProject['sample'];
    slug?: string;
  },
  owner: User,
): Promise<OntologyProject> {
  let initialized: OntologyProject | undefined;
  try { return await transaction(async () => {
  await checkFence();
  const slug = input.slug ?? await uniqueSlug(slugify(input.title));
  // The writer lock reserves this slug through store initialisation and metadata creation, on both stores.
  if ((await list<OntologyProject>('ontologies')).some((p) => p.slug === slug)) throw new SlugConflictError(slug);
  const prefix = input.prefix.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase() || 'ex';
  let graph: Graph;
  if (input.seedTurtle) graph = await OntologyGraph.fromTurtle(input.seedTurtle);
  else {
    const iri = input.namespace ? input.namespace.replace(/[#/]$/, '') : `https://w3id.org/odi/${slug}`;
    graph = OntologyGraph.empty({
      iri,
      namespace: input.namespace ?? `${iri}#`,
      prefix,
      title: input.title,
      description: input.description,
      creators: input.creditCreator === true ? [owner.name] : [],
      license: 'https://creativecommons.org/licenses/by/4.0/',
    });
  }
  const now = clock.iso();
  const project: OntologyProject = {
    id: newId('ont'),
    slug,
    title: input.title,
    description: input.description,
    namespace: graph.namespace,
    prefix,
    ontologyIRI: graph.ontologyIRI,
    stage: input.seedTurtle ? 'drafting' : 'discovery',
    // Made under the approval rules: nothing it publishes predates them.
    publishedWithApproval: true,
    currentVersion: '0.0.0',
    ownerIds: [owner.id],
    governance: template(input.governanceTemplate),
    createdAt: now,
    updatedAt: now,
    domain: input.domain,
    demo: input.demo,
    sample: input.sample,
  };
  const attribution = input.sample;
  const sampleNotice = attribution ? [
    '## Sample copy',
    `This is a sample copy for trying Concord. The original is published by ${attribution.publisher}: [${attribution.sourceTitle}](${attribution.source}). Licence: [${attribution.licence.name}](${attribution.licence.url}). Used by ${attribution.usedBy}.`,
    attribution.copyrightNotice,
    attribution.authors?.length ? `Modified from ${attribution.sourceTitle} by ${attribution.authors.join(' and ')}.` : undefined,
    attribution.licence.noticePath ? `[Full licence notice](${config.publicUrl}${attribution.licence.noticePath}) · [${attribution.licence.copyPath!.slice(1)}](${config.publicUrl}${attribution.licence.copyPath})` : undefined,
    '[What the conversion changed](#conversion-changes)',
    '### Conversion changes',
    attribution.changes,
    '',
  ].filter((p) => p !== undefined).join('\n\n') : '';
  const readme = `# ${input.title}\n\n${input.description}\n\n- Ontology IRI: <${graph.ontologyIRI}>\n- Namespace: \`${prefix}:\` <${graph.namespace}>\n- Licence: ${input.sample ? `[${input.sample.licence.name}](${input.sample.licence.url})` : 'CC BY 4.0'}\n\n${sampleNotice}Managed with Concord. The working draft is \`ontology.ttl\`; released versions are in \`releases/<version>/\` and tagged \`v<version>\`.\n`;
  // No project holds this slug, so any ontology history kept under it is an orphan from a creation that failed
  // before its clean-up ran: start from a fresh history rather than inheriting it.
  await ontologyStore.forget(project);
  // Marked before initialising, so a failure part way through initialisation is cleaned up too.
  initialized = project;
  await ontologyStore.init(project, await graph.toTurtle(), readme);
  try {
    await put('ontologies', project);
    await setRoles(project.id, owner.id, ['owner', 'steward', 'editor', 'member']);
    await logActivity({ ontologyId: project.id, actorId: owner.id, type: 'ontology.created', message: `created the ontology ${project.title}`, link: `/o/${project.id}` });
    return project;
  } catch (err) {
    // Metadata rolls back with this transaction. Git files do not: discard them before the
    // writer lock releases the slug, so a retry starts with a fresh history on either store.
    try {
      await ontologyStore.forget(project);
      initialized = undefined;
    } catch { /* An aborted database transaction may prevent cleanup; retry after rollback below. */ }
    throw err;
  }
  }); } catch (err) {
    if (initialized) {
      const failed = initialized;
      // Also covers COMMIT failing after the callback succeeded. Recheck under the writer lock:
      // an ambiguous commit or another creator may already have reserved this slug.
      await transaction(async () => {
        if (!(await list<OntologyProject>('ontologies')).some((p) => p.slug === failed.slug)) await ontologyStore.forget(failed);
      });
    }
    throw err;
  }
}

async function uniqueSlug(base: string) {
  // "fed" is taken by federation releases (/def/fed/...).
  const taken = new Set(['fed', ...SAMPLE_VOCABULARIES.map((s) => s.slug), ...(await list<OntologyProject>('ontologies')).map((o) => o.slug)]);
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

export async function updateProject(p: OntologyProject): Promise<OntologyProject> {
  p.updatedAt = clock.iso();
  return await put('ontologies', p);
}

/**
 * Hand ownership to another person, or open the vote or ODI approval the policy asks for. The check and every
 * update happen in one transaction, reading the project afresh: two transfers started at once by the same owner
 * could otherwise both pass the check and leave two owners in a single-owner project.
 */
export async function transferOwnership(ontologyId: string, user: User, toUserId: string) { return transaction(async () => {
  const p = await mustGet<OntologyProject>('ontologies', ontologyId);
  await requireRole(p.id, user, ['owner'], 'transfer ownership');
  const to = await getUser(toUserId);
  if (!to) throw new HttpError(404, 'No such user');
  const transfer = p.governance.ownership.transfer;
  if (transfer === 'owner-decides' || user.isPlatformAdmin) {
    const keepGroup = p.governance.ownership.model === 'group';
    p.ownerIds = keepGroup ? [...new Set([...p.ownerIds, to.id])] : [to.id];
    // A single owner: demote whoever holds ownership now, not just the caller. A platform admin can transfer
    // without being an owner, and two such transfers at once would otherwise each leave their recipient an owner.
    if (!keepGroup)
      for (const m of await members(p.id))
        if (m.userId !== to.id && m.roles.includes('owner')) await setRoles(p.id, m.userId, m.roles.filter((x) => x !== 'owner'));
    await setRoles(p.id, to.id, [...await rolesFor(p.id, to.id), 'owner']);
    await updateProject(p);
    return { status: 'transferred' as const };
  }
  const id = newId('xfer');
  await put('kv', { id, kind: 'ownership-transfer', ontologyId: p.id, from: user.id, to: to.id, needs: transfer, at: clock.iso() });
  return { status: transfer === 'member-vote' ? ('vote-opened' as const) : ('awaiting-odi-approval' as const), voteId: id };
}); }

export async function setGovernance(p: OntologyProject, policy: GovernancePolicy, actor: User) { return transaction(async () => {
  p.governance = policy;
  await updateProject(p);
  await logActivity({ ontologyId: p.id, actorId: actor.id, type: 'governance.updated', message: `changed the governance policy to “${policy.name}”`, link: `/o/${p.id}/governance` });
  return p;
}); }

/* ------------------------------------------------------------------------ */
/* Validation cache                                                          */
/* ------------------------------------------------------------------------ */

const validationCache = new Map<string, Promise<ValidationReport>>();

/**
 * Competency questions from use cases that have SPARQL tests attached. Validation
 * reports are public (and saved on change requests), so only public use cases'
 * questions run in them; a use case that stops being public has its questions
 * removed from saved reports too (services/useCases.ts).
 */
export async function competencyTests(ontologyId: string, opts: { published?: boolean } = {}) {
  // Public pages use the demo's fixed questions, never text a tester typed as a persona.
  const useCases = await list<UseCase>('useCases', ontologyId);
  return (opts.published ? await filterAsync(useCases, async (u) => !!u.demoSeed || !(await getUser(u.authorId))?.simulated) : useCases)
    .filter((u) => u.status !== 'archived' && u.status !== 'draft' && u.visibility === 'public' && !u.withdrawnAt)
    .flatMap((u) => (opts.published ? u.demoSeed?.competencyQuestions ?? u.competencyQuestions : u.competencyQuestions).map((q) => ({ q, source: u.id })))
    .filter(({ q }) => q.sparql)
    .map(({ q, source }) => ({ id: q.id, question: q.question, sparql: q.sparql!, exampleData: q.exampleData, exampleAnswer: q.exampleAnswer, source }));
}

export async function validateGraph(key: string, graph: Graph, cqs: { question: string; sparql: string; exampleData?: string; source?: string }[], ontologyId: string) {
  const fair = await fairContext(graph.ontologyIRI, ontologyId);
  key += fair.unreleased ? ':unreleased' : ':published';
  const r = fair.resolution;
  key += r ? `:${+r.rdf}${+r.html}` : '';
  // Checked with what it imports: a new release or draft of an imported ontology gives a new key.
  const imports = await hostedImportClosure(graph);
  key += imports.direct.length ? `:imports=${closureFingerprint(imports)}` : '';
  let p = validationCache.get(key);
  if (!p) {
    p = validate(graph, { cqs, reasoner: 'owl', owlReasoner: reasonInWorker, fair, imports });
    validationCache.set(key, p);
    p.catch(() => validationCache.delete(key));
  }
  return p;
}

export async function workingValidation(p: OntologyProject): Promise<ValidationReport> {
  const revision = await ontologyStore.head(p);
  const graph = await ontologyStore.working(p);
  // A commit landed while the graph loaded: start again so the revision names this graph.
  if ((await ontologyStore.head(p)) !== revision) return workingValidation(p);
  const cqs = await competencyTests(p.id);
  // Keyed by the questions' content, so a change in which questions run (or what they say) never reuses an old report.
  const digest = createHash('sha256').update(JSON.stringify(cqs)).digest('hex').slice(0, 16);
  return { ...(await validateGraph(`${p.slug}@${revision}:${digest}`, graph, cqs, p.id)), revision };
}

/**
 * An ontology with its counts and health. `withGraph: false` leaves out
 * everything read from the working draft (its counts and health) without
 * reading it: for callers who mustn't see a draft that waits for approval.
 * Use cases are counted as `viewer` may see them.
 */
export async function summary(p: OntologyProject, { withHealth = true, withGraph = true, viewer }: { withHealth?: boolean; withGraph?: boolean; viewer?: User } = {}): Promise<OntologySummary> {
  const view = withGraph ? (await ontologyStore.working(p)).view() : undefined;
  const crs = await list<ChangeRequest>('changeRequests', p.id);
  let health: OntologySummary['health'];
  if (withGraph && withHealth) {
    try {
      const v = await workingValidation(p);
      health = {
        passed: v.passed,
        errors: v.lint.filter((i) => i.severity === 'error').length,
        warnings: v.lint.filter((i) => i.severity === 'warning').length,
        fairScore: v.fair.score,
        consistent: v.reasoner.consistent && v.reasoner.unsatisfiable.length === 0,
        reasoner: v.reasoner.available ? v.reasoner.engine : 'structural',
        reasonerChecked: v.reasoner.checked ?? (v.reasoner.available ? 'complete' : 'none'),
        reasonerConsistent: v.reasoner.consistent,
        unsatisfiable: v.reasoner.unsatisfiable.length,
        // Required checks that could not run. FAIR checks that need the network are left out of the score instead.
        incomplete: v.reasoner.available
          ? []
          : [
              v.reasoner.checked === 'consistency'
                ? `OWL reasoner showed the draft is consistent but couldn't check every class, so validation can't pass${v.reasoner.error ? `: ${v.reasoner.error}` : ''}`
                : `OWL reasoner gave no verdict, so validation can't pass${v.reasoner.error ? `: ${v.reasoner.error}` : ''}`,
            ],
      };
    } catch (err) {
      console.warn(`[validate] ${p.slug}: ${(err as Error).message}`);
    }
  }
  // The same visibility rule as canSee in services/useCases.ts, checked once per membership.
  const group = await isGroupMember(p.id, viewer);
  const visibleUseCases = (await list<UseCase>('useCases', p.id)).filter((u) => {
    if (viewer && u.authorId === viewer.id) return true;
    if (u.withdrawnAt || u.visibility === 'private') return false;
    return (u.visibility === 'public' && u.status !== 'archived' && u.status !== 'draft') || group;
  });
  return {
    ...p,
    stats: {
      ...(view && {
        classes: view.classes.length,
        properties: view.objectProperties.length + view.datatypeProperties.length,
        individuals: view.individuals.length,
      }),
      // Only the use cases this viewer can see, so the count doesn't reveal private ones.
      useCases: visibleUseCases.length,
      // An interview makes its draft before anything is said: only use cases that say something count.
      activeUseCases: visibleUseCases.filter((u) => !u.withdrawnAt && u.status !== 'archived' && u.completeness > 0).length,
      openChangeRequests: crs.filter((c) => !['merged', 'released', 'rejected', 'withdrawn'].includes(c.status)).length,
      releases: (await list<Release>('releases', p.id)).filter((r) => r.status === 'published').length,
      members: (await members(p.id)).length,
    },
    health,
  };
}

export async function membersWithUsers(ontologyId: string) {
  return (await Promise.all((await members(ontologyId))
    .map(async (m) => ({ ...m, user: (await getUser(m.userId))! }))))
    .filter((m) => m.user);
}
