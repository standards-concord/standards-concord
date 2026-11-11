import { afterAll, beforeAll, expect, it, vi } from 'vitest';
// Exercise the real governance services with Concord's supported database ontology
// store; this integration test needs neither a listening HTTP socket nor git.
const priorStore = vi.hoisted(() => { const prior = process.env.ONTOLOGY_STORE; process.env.ONTOLOGY_STORE = 'db'; return prior; });
import { openDb } from '../src/db.js';
import { clock, DAY_MS } from '../src/clock.js';
import { createProject, rolesFor, setGovernance, setRoles } from '../src/services/ontologies.js';
import { createUser } from '../src/services/users.js';
import { proposeCodeListEdit } from '../src/services/codeListEdits.js';
import { addReview, advance, getCR, merge } from '../src/services/changeRequests.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { pageInput } from '../src/public/routes.js';
import { renderOntologyPage } from '../src/public/render.js';

beforeAll(() => openDb());
afterAll(() => { if (priorStore === undefined) delete process.env.ONTOLOGY_STORE; else process.env.ONTOLOGY_STORE = priorStore; });

// Competing parent moves are a service race: a browser cannot control merge ordering reliably.
// The second move used to silently overwrite the first after both were approved.
it('sends a competing parent move back for revision after the first move merges', async () => clock.withShift(0, async () => {
  const person = (name: string) => createUser({ name, provider: 'demo', subject: name });
  const [owner, author, steward] = await Promise.all(['Move owner', 'Move author', 'Move steward'].map(person));
  const project = await createProject({ title: 'Competing code moves', prefix: 'cm', description: 'Parent move conflicts', governanceTemplate: 'working-group' }, owner);
  await setRoles(project.id, steward.id, ['steward']);
  // Keep real approval rounds and auto-merges, with one steward deciding each level.
  const policy = structuredClone(project.governance);
  for (const level of ['patch', 'minor', 'major'] as const) {
    Object.assign(policy.changes[level], { approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 1 });
    delete policy.changes[level].vote;
  }
  await setGovernance(project, policy, owner);
  const ns = project.namespace;
  const seed = await proposeCodeListEdit(project, author, { submit: true, ops: [
    { op: 'addConceptScheme', localName: 'Codes', label: 'codes', definition: 'Controlled codes' },
    ...['child', 'first', 'second'].map((localName) => ({ op: 'addConcept' as const, scheme: ns + 'Codes', localName, label: localName, definition: `The ${localName} code` })),
  ] });
  await addReview(seed, steward, 'approve', undefined, seed.round ?? 1);
  clock.advance(2 * DAY_MS);
  expect((await advance(await getCR(seed.id), steward)).status).toBe('merged');

  const move = (parent: string) => proposeCodeListEdit(project, author, { submit: true, ops: [{ op: 'moveConcept', iri: ns + 'child', broader: ns + parent }] });
  const first = await move('first');
  const second = await move('second');
  expect(first.classification?.level).toBe('major');
  expect(second.validation?.passed).toBe(true);
  await addReview(first, steward, 'approve', undefined, first.round ?? 1);
  await addReview(second, steward, 'approve', undefined, second.round ?? 1);
  clock.advance(2 * DAY_MS);
  expect((await advance(await getCR(first.id), steward)).status).toBe('merged');
  const failed = await advance(await getCR(second.id), steward);
  expect(failed.status).toBe('needs-work');
  expect(failed.validation?.lint).toContainEqual(expect.objectContaining({ code: 'change-not-applicable', message: expect.stringMatching(/parent.*changed since/) }));
  expect((await ontologyStore.working(project)).term(ns + 'child')).toMatchObject({ broader: [ns + 'first'] });
  await expect(proposeCodeListEdit(project, author, { ops: [{ op: 'moveConcept', iri: ns + 'child', broader: ns + 'second', previous: { broader: null } }] })).rejects.toMatchObject({ status: 409 });
}));

it('governs contributor code proposals through genuine review rounds and merges, and guards later stale edits', async () => clock.withShift(0, async () => {
  const person = (name: string) => createUser({ name, provider: 'demo', subject: name });
  const [owner, contributor, reviewer, steward] = await Promise.all(['Owner', 'Contributor', 'Reviewer', 'Steward'].map(person));
  const project = await createProject({ title: 'Governed activities', prefix: 'ga', description: 'Permitted activities', governanceTemplate: 'working-group' }, owner);
  await setRoles(project.id, reviewer.id, ['reviewer']);
  await setRoles(project.id, steward.id, ['steward']);
  const ns = project.namespace;
  const scheme = ns + 'Activities';
  const code = ns + 'gardening';
  let cr = await proposeCodeListEdit(project, contributor, { submit: true, ops: [
    { op: 'addConceptScheme', localName: 'Activities', label: 'activities', definition: 'Permitted activities' },
    { op: 'addConcept', localName: 'outdoor', label: 'outdoor', definition: 'Activities outside', scheme },
    { op: 'addConcept', localName: 'gardening', label: 'gardening', definition: 'Growing plants', notation: 'GARD', scheme, broader: ns + 'outdoor' },
  ] });
  expect(await rolesFor(project.id, contributor.id)).toEqual(['contributor']);
  expect(cr.validation?.passed).toBe(true);
  expect(cr.classification?.level).toBe('minor');
  expect((await ontologyStore.working(project)).view().concepts).toEqual([]);
  await expect(merge(cr, contributor)).rejects.toMatchObject({ status: 403 });
  cr = await addReview(cr, reviewer, 'approve', undefined, cr.round ?? 1);
  cr = await addReview(cr, steward, 'approve', undefined, cr.round ?? 1);
  clock.advance(8 * DAY_MS);
  cr = await advance(await getCR(cr.id), steward);
  expect(cr.status).toBe('merged');
  const draft = await ontologyStore.working(project);
  expect(draft.term(code)).toMatchObject({ kind: 'concept', notation: 'GARD', broader: [ns + 'outdoor'] });
  expect(draft.view().conceptSchemes[0].topConcepts).toEqual([ns + 'outdoor']);
  const html = renderOntologyPage(await pageInput(project, 'draft', 'https://concord.example'));
  expect(html).toContain('Code lists');
  expect(html).toContain('id="gardening"');

  const first = await proposeCodeListEdit(project, contributor, { submit: true, ops: [{ op: 'updateConcept', iri: code, set: { label: 'horticulture' }, previous: { label: 'gardening' } }] });
  const second = await proposeCodeListEdit(project, contributor, { submit: true, ops: [{ op: 'updateConcept', iri: code, set: { label: 'planting' }, previous: { label: 'gardening' } }] });
  await addReview(first, steward, 'approve', undefined, first.round ?? 1);
  await addReview(second, steward, 'approve', undefined, second.round ?? 1);
  clock.advance(2 * DAY_MS);
  expect((await advance(await getCR(first.id), steward)).status).toBe('merged');
  expect((await advance(await getCR(second.id), steward)).status).toBe('needs-work');
  expect((await ontologyStore.working(project)).term(code)?.label).toBe('horticulture');
  await expect(proposeCodeListEdit(project, contributor, { ops: [{ op: 'updateConcept', iri: code, set: { label: 'growing' }, previous: { label: 'gardening' } }] })).rejects.toMatchObject({ status: 409 });
  const meaning = await proposeCodeListEdit(project, contributor, { ops: [{ op: 'updateConcept', iri: code, set: { definition: 'Planting and construction work' }, definitionIntent: 'new-meaning' }] });
  expect(meaning.classification?.level).toBe('major');
  expect(meaning.classification?.reasons.some((r) => r.rule === 'meaning-changed')).toBe(true);
}));
