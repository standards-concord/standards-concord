import type { OntologyView } from '@concord/core/types';
import { applyChangeOps, OntologyGraph, termNamespace } from '@concord/core';
import { changesToOps, proposalError, undoChange, type PendingChange } from './diagramProposals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiagramProposalStorage, readProposalDraft, rebaseProposalDraft, writeProposalDraft, type ProposalDraft } from './diagramProposalStorage';

const draft: ProposalDraft = {
  namespace: 'https://example.org/old#',
  title: 'Add coordinator', description: 'A proposed class.',
  items: [{ id: 'one', kind: 'class', localName: 'Coordinator', label: 'coordinator', definition: 'A person who coordinates sessions.' }],
};
const empty: ProposalDraft = { items: [], title: '', description: '' };
let saved: Record<string, string>;

beforeEach(() => {
  saved = {};
  // Enumeration and item methods behave like browser localStorage.
  vi.stubGlobal('localStorage', new Proxy(saved, {
    get(target, property) {
      if (property === 'getItem') return (key: string) => target[key] ?? null;
      if (property === 'setItem') return (key: string, value: string) => { target[key] = value; };
      if (property === 'removeItem') return (key: string) => { delete target[key]; };
      return Reflect.get(target, property);
    },
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('diagram proposal storage', () => {
  it('restores items and the request text, isolated by both account and ontology', () => {
    writeProposalDraft('alice', 'ontology-one', draft);
    expect(readProposalDraft('alice', 'ontology-one')).toEqual(draft);
    expect(readProposalDraft('bob', 'ontology-one')).toEqual(empty);
    expect(readProposalDraft('alice', 'ontology-two')).toEqual(empty);
    expect(Object.keys(saved)[0]).toContain('alice.ontology-one');
  });

  it('removes an empty draft and clears all ontologies and accounts without touching other storage', () => {
    writeProposalDraft('alice', 'one', draft);
    writeProposalDraft('alice', 'two', draft);
    writeProposalDraft('bob', 'one', draft);
    writeProposalDraft('alice', 'one', empty);
    expect(readProposalDraft('alice', 'one')).toEqual(empty);
    saved['concord.other'] = 'keep';
    clearDiagramProposalStorage();
    expect(saved).toEqual({ 'concord.other': 'keep' });
  });

  it('ignores corrupt JSON and malformed pending items', () => {
    writeProposalDraft('alice', 'one', draft);
    const key = Object.keys(saved)[0];
    saved[key] = '{';
    expect(readProposalDraft('alice', 'one')).toEqual(empty);
    saved[key] = JSON.stringify({ ...draft, items: [{ id: 'x', kind: 'superclass', superClasses: 'not an array' }] });
    expect(readProposalDraft('alice', 'one')).toMatchObject({ items: [], storageError: expect.stringMatching(/cannot be read/), unavailableItems: [{ id: 'x', kind: 'superclass', superClasses: 'not an array' }] });
  });

  it('keeps rendering when storage reads, writes, removal or enumeration fail', () => {
    vi.stubGlobal('localStorage', new Proxy({}, {
      get() { throw new Error('Storage blocked'); },
      ownKeys() { throw new Error('Storage blocked'); },
    }));
    expect(readProposalDraft('alice', 'one')).toEqual(empty);
    expect(() => writeProposalDraft('alice', 'one', draft)).not.toThrow();
    expect(() => writeProposalDraft('alice', 'one', empty)).not.toThrow();
    expect(() => clearDiagramProposalStorage()).not.toThrow();
  });
});


describe('restored diagram drafts', () => {
  const current = 'https://example.org/current/';
  const old = draft.namespace!;
  const existing = 'https://example.org/existing#Parent';
  const view: OntologyView = { metadata: { iri: current, creators: [], contributors: [], imports: [] }, classes: [], datatypeProperties: [], objectProperties: [], annotationProperties: [], individuals: [], conceptSchemes: [], concepts: [], prefixes: {}, tripleCount: 0 };

  it('rebases only draft-minted references when the current graph namespace changes', () => {
    const original: ProposalDraft = { ...draft, items: [
      { ...draft.items[0], kind: 'class', localName: 'Coordinator', label: 'coordinator', definition: 'A coordinator.', parent: existing },
      { id: 'child', kind: 'class', localName: 'Junior', label: 'junior', definition: 'A junior.', parent: old + 'Coordinator' },
      { id: 'attr', kind: 'attribute', localName: 'name', label: 'name', definition: 'A name.', classIri: old + 'Junior', range: 'http://www.w3.org/2001/XMLSchema#string', howMany: 'min' },
      { id: 'rel', kind: 'relationship', localName: 'worksWith', label: 'works with', definition: 'A colleague.', from: old + 'Coordinator', to: old + 'Junior', howMany: 'any' },
      { id: 'super', kind: 'superclass', classIri: old + 'Junior', parent: old + 'Coordinator', mode: 'add' },
    ] };
    writeProposalDraft('alice', 'one', original);
    const rebased = rebaseProposalDraft(readProposalDraft('alice', 'one'), current);
    expect(rebased.namespace).toBe(current);
    expect(rebased.items[0]).toMatchObject({ parent: existing });
    expect(rebased.items[1]).toMatchObject({ parent: current + 'Coordinator' });
    expect(rebased.items[2]).toMatchObject({ classIri: current + 'Junior' });
    expect(rebased.items[3]).toMatchObject({ from: current + 'Coordinator', to: current + 'Junior' });
    expect(rebased.items[4]).toMatchObject({ classIri: current + 'Junior', parent: current + 'Coordinator' });
    expect(original.items[1]).toMatchObject({ parent: old + 'Coordinator' });
    writeProposalDraft('alice', 'one', rebased);
    expect(readProposalDraft('alice', 'one')).toEqual(rebased);
  });

  it('preserves a legacy draft without a namespace but blocks sending it', () => {
    const { namespace: _, ...legacy } = draft;
    writeProposalDraft('alice', 'one', legacy);
    const restored = rebaseProposalDraft(readProposalDraft('alice', 'one'), current);
    expect(restored.items).toEqual(draft.items);
    expect(restored.storageError).toMatch(/no namespace/);
    // Unsupported old shapes also remain stored, with a notice instead of silently losing them.
    saved[Object.keys(saved)[0]] = JSON.stringify({ ...draft, items: [{ id: 'old', kind: 'superclass', classIri: existing, superClasses: [current + 'Coordinator'] }] });
    const unreadable = readProposalDraft('alice', 'one');
    expect(unreadable.storageError).toMatch(/cannot be read/);
    expect(unreadable.unavailableItems).toHaveLength(1);
    writeProposalDraft('alice', 'one', unreadable);
    expect(readProposalDraft('alice', 'one')).toEqual(unreadable);
  });

  it('ignores legacy superclass snapshots while preserving and revalidating their intent', () => {
    writeProposalDraft('alice', 'one', draft);
    saved[Object.keys(saved)[0]] = JSON.stringify({ ...draft, items: [{ id: 'legacy', kind: 'superclass', classIri: existing, parent: current + 'Missing', mode: 'add', superClasses: [old + 'UndoneParent'] }] });
    const restored = readProposalDraft('alice', 'one');
    expect(restored.items[0]).not.toHaveProperty('superClasses');
    expect(restored.items).toHaveLength(1);
    expect(proposalError(view, restored.items, current)).toMatch(/no longer available/);
  });

  it('revalidates names, missing references and cycles in localStorage before sending', () => {
    const classView = (name: string, parents: string[] = []) => ({ iri: current + name, kind: 'class' as const, superClasses: parents, equivalentClasses: [], disjointWith: [], restrictions: [] });
    const currentView = { ...view, classes: [classView('A', [current + 'B']), classView('B')] };
    for (const items of [
      [{ ...draft.items[0], kind: 'class' as const, localName: '1Thing', label: 'thing', definition: 'A thing.' }],
      [{ ...draft.items[0], kind: 'class' as const, localName: 'thing', label: 'thing', definition: 'A thing.' }],
      [{ id: 'missing', kind: 'superclass' as const, classIri: current + 'A', parent: current + 'Missing', mode: 'add' as const }],
      [{ id: 'cycle', kind: 'superclass' as const, classIri: current + 'B', parent: current + 'A', mode: 'add' as const }],
    ]) {
      writeProposalDraft('alice', 'one', { ...draft, namespace: current, items });
      const restored = rebaseProposalDraft(readProposalDraft('alice', 'one'), current);
      expect(restored.items).toHaveLength(1);
      expect(proposalError(currentView, restored.items, current)).toBeTruthy();
      expect(() => changesToOps(restored.items, current, currentView)).toThrow();
    }
  });

  it('blocks a cycle through a preserved superclass intersection after Undo and storage restore', () => {
    // This saved draft used to pass validation despite A -> B -> C -> A after Undo.
    const classView = (name: string, parents: string[] = []) => ({ iri: current + name, kind: 'class' as const, superClasses: parents, equivalentClasses: [], disjointWith: [], restrictions: [] });
    const currentView: OntologyView = { ...view, classes: [
      classView('A', [current + 'B']),
      { ...classView('B'), superClassConjuncts: [{ expression: '_:intersection', classes: [current + 'C', current + 'D'], restrictions: [] }] },
      classView('C'), classView('D'), classView('E'),
    ] };
    const first: PendingChange = { id: 'first', kind: 'superclass', classIri: current + 'A', parent: current + 'E', mode: 'replace' };
    const second: PendingChange = { id: 'second', kind: 'superclass', classIri: current + 'C', parent: current + 'A', mode: 'add' };
    writeProposalDraft('alice', 'one', { ...draft, namespace: current, items: [first, second] });
    const restored = rebaseProposalDraft(readProposalDraft('alice', 'one'), current);
    expect(proposalError(currentView, restored.items, current)).toBeUndefined();
    const items = undoChange(restored.items, first.id, current).items;
    expect(items).toEqual([second]);
    expect(proposalError(currentView, items, current)).toMatch(/subclasses/);
    writeProposalDraft('alice', 'one', { ...restored, items });
    const afterReload = rebaseProposalDraft(readProposalDraft('alice', 'one'), current);
    expect(afterReload.items).toEqual([second]);
    expect(proposalError(currentView, afterReload.items, current)).toMatch(/subclasses/);
    expect(() => changesToOps(afterReload.items, current, currentView)).toThrow(/subclasses/);
  });

  it('blocks a rebased draft when its names now clash with current terms', () => {
    const rebased = rebaseProposalDraft(draft, current);
    const currentView = { ...view, classes: [{ iri: current + 'Coordinator', kind: 'class' as const, superClasses: [], equivalentClasses: [], disjointWith: [], restrictions: [] }] };
    expect(proposalError(currentView, rebased.items, current)).toMatch(/already used/);
    expect(() => changesToOps(rebased.items, current, currentView)).toThrow(/already used/);
  });

  it('rebases a draft after merged preferredNamespace metadata and applies its dependent ops', () => {
    const graph = OntologyGraph.empty({ iri: 'https://example.org/o', namespace: old, prefix: 'ex', title: 'Test' });
    const updated = applyChangeOps(graph, [{ op: 'setMetadata', set: { preferredNamespace: current } }]).graph;
    const namespace = termNamespace(updated.view().metadata, updated.view().prefixes);
    expect(namespace).toBe(current);
    const savedDraft: ProposalDraft = { ...draft, items: [...draft.items, { id: 'attr', kind: 'attribute', localName: 'name', label: 'name', definition: 'A name.', classIri: old + 'Coordinator', range: 'http://www.w3.org/2001/XMLSchema#string', howMany: 'min' }] };
    writeProposalDraft('alice', 'one', savedDraft);
    const restored = rebaseProposalDraft(readProposalDraft('alice', 'one'), namespace);
    const result = applyChangeOps(updated, changesToOps(restored.items, namespace, updated.view())).graph;
    expect(result.isClassIri(current + 'Coordinator')).toBe(true);
    expect(result.classView(current + 'Coordinator').restrictions[0]).toMatchObject({ property: current + 'name', kind: 'min' });
    expect(result.isDeclared(old + 'Coordinator')).toBe(false);
  });
});
