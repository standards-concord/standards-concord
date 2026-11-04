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
import { get, HttpError, list, mustGet, put, remove } from '../db.js';
import { newId, slugify } from '../ids.js';
import { template } from './governance.js';
import { ontologyStore } from './ontologyStore.js';
import { getUser, logActivity } from './users.js';

export const getProject = (id: string) => mustGet<OntologyProject>('ontologies', id);
export const findProject = (idOrSlug: string) =>
  get<OntologyProject>('ontologies', idOrSlug) ?? list<OntologyProject>('ontologies').find((o) => o.slug === idOrSlug);
export const mustFindProject = (idOrSlug: string) => {
  const p = findProject(idOrSlug);
  if (!p) throw new HttpError(404, `Ontology ${idOrSlug} not found`);
  return p;
};

export const members = (ontologyId: string) => list<Membership>('memberships', ontologyId);
export const rolesFor = (ontologyId: string, userId: string | undefined): Role[] =>
  userId ? (get<Membership>('memberships', `${ontologyId}:${userId}`)?.roles ?? []) : [];

export function setRoles(ontologyId: string, userId: string, roles: Role[]): Membership {
  const id = `${ontologyId}:${userId}`;
  const existing = get<Membership & { id: string }>('memberships', id);
  const m = { id, ontologyId, userId, roles: [...new Set(roles)], addedAt: existing?.addedAt ?? clock.iso() };
  put('memberships', m, ontologyId);
  return m;
}
export function removeMember(ontologyId: string, userId: string) {
  remove('memberships', `${ontologyId}:${userId}`);
}

export function requireRole(ontologyId: string, user: User | undefined, roles: Role[], action: string) {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (user.isPlatformAdmin) return;
  const have = rolesFor(ontologyId, user.id);
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
    /** List the owner as dct:creator, which is public on the ontology's page. Default true. */
    creditCreator?: boolean;
    seedTurtle?: string;
    demo?: boolean;
    slug?: string;
  },
  owner: User,
): Promise<OntologyProject> {
  const slug = input.slug ?? uniqueSlug(slugify(input.title));
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
      creators: input.creditCreator === false ? [] : [owner.name],
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
  put('ontologies', project);
  setRoles(project.id, owner.id, ['owner', 'steward', 'editor', 'member']);
  logActivity({ ontologyId: project.id, actorId: owner.id, type: 'ontology.created', message: `created the ontology ${project.title}`, link: `/o/${project.id}` });
  return project;
}

function uniqueSlug(base: string) {
  const taken = new Set(list<OntologyProject>('ontologies').map((o) => o.slug));
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

export function updateProject(p: OntologyProject): OntologyProject {
  p.updatedAt = clock.iso();
  return put('ontologies', p);
}

export function setGovernance(p: OntologyProject, policy: GovernancePolicy, actor: User) {
  p.governance = policy;
  updateProject(p);
  logActivity({ ontologyId: p.id, actorId: actor.id, type: 'governance.updated', message: `changed the governance policy to “${policy.name}”`, link: `/o/${p.id}/governance` });
  return p;
}

/* ------------------------------------------------------------------------ */
/* Validation cache                                                          */
/* ------------------------------------------------------------------------ */

const validationCache = new Map<string, Promise<ValidationReport>>();

/** Competency questions from use cases that have SPARQL tests attached. */
export function competencyTests(ontologyId: string) {
  return list<UseCase>('useCases', ontologyId)
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
  const cqs = competencyTests(p.id);
  return validateGraph(`${p.slug}@${ontologyStore.head(p)}:${cqs.length}`, graph, cqs);
}

export async function summary(p: OntologyProject, withHealth = true): Promise<OntologySummary> {
  const graph = await ontologyStore.working(p);
  const view = graph.view();
  const crs = list<ChangeRequest>('changeRequests', p.id);
  let health: OntologySummary['health'];
  if (withHealth) {
    try {
      const v = await workingValidation(p);
      health = {
        passed: v.passed,
        errors: v.lint.filter((i) => i.severity === 'error').length,
        warnings: v.lint.filter((i) => i.severity === 'warning').length,
        fairScore: v.fair.score,
        consistent: v.reasoner.consistent && v.reasoner.unsatisfiable.length === 0,
      };
    } catch (err) {
      console.warn(`[validate] ${p.slug}: ${(err as Error).message}`);
    }
  }
  return {
    ...p,
    stats: {
      classes: view.classes.length,
      properties: view.objectProperties.length + view.datatypeProperties.length,
      individuals: view.individuals.length,
      useCases: list<UseCase>('useCases', p.id).length,
      openChangeRequests: crs.filter((c) => !['merged', 'released', 'rejected', 'withdrawn'].includes(c.status)).length,
      releases: list<Release>('releases', p.id).filter((r) => r.status === 'published').length,
      members: members(p.id).length,
    },
    health,
  };
}

export function membersWithUsers(ontologyId: string) {
  return members(ontologyId)
    .map((m) => ({ ...m, user: getUser(m.userId)! }))
    .filter((m) => m.user);
}
