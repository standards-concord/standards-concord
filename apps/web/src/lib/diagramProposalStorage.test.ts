import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiagramProposalStorage, readProposalDraft, writeProposalDraft, type ProposalDraft } from './diagramProposalStorage';

const draft: ProposalDraft = {
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
    expect(readProposalDraft('alice', 'one')).toEqual(empty);
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
