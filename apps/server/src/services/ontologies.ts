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
import { clock } from '../clock.js';
import { transaction, get, HttpError, list, mustGet, put, remove } from '../db.js';
import { newId, slugify } from '../ids.js';
import { template } from './governance.js';
import { ontologyStore } from './ontologyStore.js';
import { getUser, logActivity } from './users.js';

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
    slug?: string;
  },
  owner: User,
): Promise<OntologyProject> {
  const slug = input.slug ?? await uniqueSlug(slugify(input.title));
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
  };
  const readme = `# ${input.title}\n\n${input.description}\n\n- Ontology IRI: <${graph.ontologyIRI}>\n- Namespace: \`${prefix}:\` <${graph.namespace}>\n- Licence: CC BY 4.0\n\nManaged on the Open Data Institute with Concord. The working draft is \`ontology.ttl\`; released versions are in \`releases/<version>/\` and tagged \`v<version>\`.\n`;
  await ontologyStore.init(project, await graph.toTurtle(), readme);
  await put('ontologies', project);
  await setRoles(project.id, owner.id, ['owner', 'steward', 'editor', 'member']);
  await logActivity({ ontologyId: project.id, actorId: owner.id, type: 'ontology.created', message: `created the ontology ${project.title}`, link: `/o/${project.id}` });
  return project;
}

async function uniqueSlug(base: string) {
  const taken = new Set((await list<OntologyProject>('ontologies')).map((o) => o.slug));
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

/** Competency questions from use cases that have SPARQL tests attached. */
export async function competencyTests(ontologyId: string) {
  return (await list<UseCase>('useCases', ontologyId))
    .filter((u) => u.status !== 'archived')
    .flatMap((u) => u.competencyQuestions)
    .filter((q) => q.sparql)
    .map((q) => ({ question: q.question, sparql: q.sparql!, exampleData: q.exampleData }));
}

export async function validateGraph(key: string, graph: Graph, cqs: { question: string; sparql: string; exampleData?: string }[]) {
  const fair = await fairContext(graph.ontologyIRI);
  const r = fair.resolution;
  key += r ? `:${+r.rdf}${+r.html}` : '';
  let p = validationCache.get(key);
  if (!p) {
    p = validate(graph, { cqs, reasoner: 'owl', fair });
    validationCache.set(key, p);
    p.catch(() => validationCache.delete(key));
  }
  return p;
}

export async function workingValidation(p: OntologyProject) {
  const graph = await ontologyStore.working(p);
  const cqs = await competencyTests(p.id);
  return validateGraph(`${p.slug}@${await ontologyStore.head(p)}:${cqs.length}`, graph, cqs);
}

/**
 * An ontology with its counts and health. `withGraph: false` leaves out
 * everything read from the working draft (its counts and health) without
 * reading it: for callers who mustn't see a draft that waits for approval.
 */
export async function summary(p: OntologyProject, { withHealth = true, withGraph = true }: { withHealth?: boolean; withGraph?: boolean } = {}): Promise<OntologySummary> {
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
        // Required checks that could not run. FAIR checks that need the network are left out of the score instead.
        incomplete: v.reasoner.available ? [] : ['OWL reasoner (HermiT) did not run, so only structural checks ran'],
      };
    } catch (err) {
      console.warn(`[validate] ${p.slug}: ${(err as Error).message}`);
    }
  }
  return {
    ...p,
    stats: {
      ...(view && {
        classes: view.classes.length,
        properties: view.objectProperties.length + view.datatypeProperties.length,
        individuals: view.individuals.length,
      }),
      useCases: (await list<UseCase>('useCases', p.id)).length,
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
