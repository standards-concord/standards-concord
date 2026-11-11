import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChangeOps, OntologyGraph } from '@concord/core';
import type { CodeListEditInput, OntologyProject, User } from '@concord/shared';

const mocks = vi.hoisted(() => ({ working: vi.fn(), create: vi.fn(), roles: vi.fn(), setRoles: vi.fn() }));
vi.mock('../src/services/ontologyStore.js', () => ({ ontologyStore: { working: mocks.working } }));
vi.mock('../src/services/changeRequests.js', () => ({ createChangeRequest: mocks.create }));
vi.mock('../src/services/ontologies.js', () => ({ rolesFor: mocks.roles, setRoles: mocks.setRoles }));
vi.mock('../src/services/budget.js', () => ({ withTriageBudget: (_user: unknown, f: () => Promise<unknown>) => f() }));
import { proposeCodeListEdit } from '../src/services/codeListEdits.js';

const ns = 'https://example.org/codes#';
const project = { id: 'project' } as OntologyProject;
const user = { id: 'user' } as User;
const empty = () => OntologyGraph.empty({ iri: 'https://example.org/codes', namespace: ns, prefix: 'ex', title: 'Codes' });
const scheme = { op: 'addConceptScheme' as const, localName: 'Activities', label: 'activities', definition: 'Allowed activities' };
const code = { op: 'addConcept' as const, localName: 'garden', label: 'gardening', definition: 'Growing plants', notation: 'GARD', scheme: ns + 'Activities' };
const run = (input: unknown) => proposeCodeListEdit(project, user, input as CodeListEditInput);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roles.mockResolvedValue([]);
  mocks.working.mockResolvedValue(empty());
  mocks.create.mockImplementation(async (_project, _user, input) => input);
});

describe('code list proposal service', () => {
  // Imported baseline text/items used to be rejected by the limits intended for new values.
  it('allows shortening oversized existing annotations while limiting replacement values', async () => {
    const definition = 'x'.repeat(4001);
    const altLabels = Array.from({ length: 51 }, (_, i) => i === 0 ? 'a'.repeat(4001) : `Alternative ${i}`);
    const g = applyChangeOps(empty(), [scheme, { ...code, definition, altLabels }]).graph;
    mocks.working.mockResolvedValue(g);
    const cr = await run({ ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { definition: 'Growing plants', altLabels: ['Gardening'] }, previous: { definition, altLabels }, definitionIntent: 'same-meaning' }] });
    expect(cr.ops[0]).toMatchObject({ set: { definition: 'Growing plants', altLabels: ['Gardening'] }, expect: { definition, altLabels: [...altLabels].sort() } });
    expect(applyChangeOps(g, cr.ops).graph.term(ns + 'garden')?.definition).toBe('Growing plants');
    await expect(run({ ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { definition } }] })).rejects.toMatchObject({ status: 400 });
    await expect(run({ ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { altLabels } }] })).rejects.toMatchObject({ status: 400 });
  });
  // A stale parent selection used to be accepted and overwrite a newer move.
  it('returns 409 for stale parent baselines and records the working parent itself', async () => {
    const g = applyChangeOps(empty(), [scheme, code, { ...code, localName: 'outdoor', notation: 'OUT' }, { ...code, localName: 'indoor', notation: 'IN' }, { op: 'moveConcept', iri: ns + 'garden', broader: ns + 'outdoor' }]).graph;
    mocks.working.mockResolvedValue(g);
    const move = { op: 'moveConcept', iri: ns + 'garden', broader: ns + 'indoor' };
    await expect(run({ ops: [{ ...move, previous: { broader: null } }] })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/parent.*changed since/) });
    expect(mocks.create).not.toHaveBeenCalled();
    const cr = await run({ ops: [{ ...move, previous: { broader: 'ex:outdoor' } }] });
    expect(cr.ops[0]).toEqual({ ...move, expect: { broader: ns + 'outdoor' } });
    const withoutBaseline = await run({ ops: [move] });
    expect(withoutBaseline.ops[0]).toEqual({ ...move, expect: { broader: ns + 'outdoor' } });
    const sequential = await run({ ops: [{ ...move, broader: null }, { ...move, previous: { broader: null } }] });
    expect(sequential.ops[1]).toEqual({ ...move, expect: { broader: null } });
  });
  it('dry runs dependent operations and creates one editorial request, enrolling contributors', async () => {
    const g = empty();
    mocks.working.mockResolvedValue(g);
    const cr = await run({ ops: [scheme, code], reason: 'Use controlled values.', submit: true });
    expect(cr).toMatchObject({ title: 'Create the code list “activities”', description: 'Use controlled values.', kind: 'editorial', origin: { type: 'code-list-edit', scheme: ns + 'Activities' }, ops: [scheme, code], submit: true });
    expect(g.view().concepts).toEqual([]);
    expect(mocks.setRoles).toHaveBeenCalledWith(project.id, user.id, ['contributor']);
  });
  it('sets the readable code addition title and keeps an existing role', async () => {
    mocks.roles.mockResolvedValue(['editor']);
    mocks.working.mockResolvedValue(applyChangeOps(empty(), [scheme]).graph);
    const cr = await run({ ops: [code, { ...code, localName: 'outdoor', label: 'outdoor', notation: 'OUT' }] });
    expect(cr.title).toBe('Add 2 codes to “activities”');
    expect(mocks.setRoles).not.toHaveBeenCalled();
  });
  it('computes expect for every edited field, including absent values, and rejects stale previous values', async () => {
    const g = applyChangeOps(empty(), [scheme, code]).graph;
    mocks.working.mockResolvedValue(g);
    const edit = { op: 'updateConcept', iri: ns + 'garden', set: { label: 'horticulture', examples: ['Growing food'] }, previous: { label: 'gardening', examples: [] } };
    const cr = await run({ ops: [edit] });
    expect(cr.ops[0]).toEqual({ op: 'updateConcept', iri: ns + 'garden', set: edit.set, expect: { label: 'gardening', examples: [] } });
    expect(g.term(ns + 'garden')?.label).toBe('gardening');
    expect(cr.title).toBe('Edit the code “gardening”');
    await expect(run({ ops: [{ ...edit, previous: { label: 'old value' } }] })).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('retains merge-time conflict protection after earlier operations in the same proposal', async () => {
    const cr = await run({ ops: [scheme, code, { op: 'updateConcept', iri: ns + 'garden', set: { notation: 'GROW' }, previous: { notation: 'GARD' } }] });
    expect(cr.ops[2]).toMatchObject({ expect: { notation: 'GARD' } });
    expect(applyChangeOps(empty(), cr.ops).graph.term(ns + 'garden')).toMatchObject({ notation: 'GROW' });
  });
  it('declares new meaning and lets definition wording use the existing review rules', async () => {
    mocks.working.mockResolvedValue(applyChangeOps(empty(), [scheme, code]).graph);
    const cr = await run({ ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { definition: 'A different meaning' }, definitionIntent: 'new-meaning' }] });
    expect(cr).toMatchObject({ declaredLevel: { level: 'major', rule: 'meaning-changed', iri: ns + 'garden' } });
  });
  it('clears property lists with the old scheme as origin and edits schemes themselves', async () => {
    const g = applyChangeOps(empty(), [scheme, code, { op: 'addObjectProperty', localName: 'activity', label: 'activity', definition: 'Activity', codeList: ns + 'Activities' }]).graph;
    mocks.working.mockResolvedValue(g);
    expect(await run({ ops: [{ op: 'setCodeList', property: ns + 'activity', scheme: null }] })).toMatchObject({ origin: { type: 'code-list-edit', scheme: ns + 'Activities' } });
    expect(await run({ ops: [{ op: 'updateConcept', iri: ns + 'Activities', set: { label: 'activity types' } }] })).toMatchObject({ title: 'Edit the code list “activities”' });
  });
  it.each([
    {}, { ops: [] }, { ops: Array.from({ length: 51 }, () => scheme) },
    { ops: [{ op: 'removeTerm', iri: ns + 'garden' }] },
    { ops: [{ ...scheme, extra: 'unrecognised' }] },
    { ops: [{ ...scheme, definition: 'x'.repeat(4001) }] },
    { ops: [{ ...scheme, altLabels: Array(51).fill('x') }] },
    { ops: [scheme], submit: 'true' }, { ops: [scheme], reason: {} },
    { ops: [{ op: 'setCodeList', property: ns + 'activity', scheme: [] }] },
    { ops: [{ op: 'updateConcept', iri: ns + 'garden', set: {} }] },
    { ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { label: 'x' }, expect: {} }] },
    { ops: [{ op: 'moveConcept', iri: ns + 'garden', broader: null, expect: { broader: null } }] },
    { ops: [{ op: 'moveConcept', iri: ns + 'garden', broader: null, previous: {} }] },
  ])('rejects invalid input before creating a request %#', async (input) => {
    await expect(run(input)).rejects.toMatchObject({ status: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.setRoles).not.toHaveBeenCalled();
  });
  it('refuses a no-op rather than opening an empty change request', async () => {
    mocks.working.mockResolvedValue(applyChangeOps(empty(), [scheme, code]).graph);
    await expect(run({ ops: [{ op: 'updateConcept', iri: ns + 'garden', set: { label: 'gardening' } }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Nothing to change/) });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('returns engine errors on failed ops without opening a request', async () => {
    await expect(run({ ops: [scheme, code, { ...code, localName: 'duplicate' }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/notation.*already used/) });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
