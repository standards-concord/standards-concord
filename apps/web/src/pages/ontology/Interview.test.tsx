import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The interview page with a finished interview whose use case has a drafted SPARQL test, for a
// viewer whose roles each test sets.
const roles = { current: [] as string[] };
const useCase = {
  id: 'uc_1',
  completeness: 0.8,
  sections: { name: 'Match volunteers' },
  competencyQuestions: [{ id: 'cq1', question: 'Which opportunities accept 15-year-olds?', sparql: 'SELECT ?o WHERE { ?o a :Opportunity }', status: 'answerable' }],
  terms: [],
  links: [],
  visibility: 'private',
  status: 'draft',
};
vi.mock('../../lib/hooks', () => ({
  useAsync: () => ({ data: { id: 's1', useCaseId: 'uc_1', done: true, messages: [], storage: { kind: 'server' }, useCase }, reload: async () => {}, setData: () => {} }),
  useAction: (fn: unknown) => Object.assign(fn as object, { run: fn, busy: false }),
}));
vi.mock('../../lib/session', () => ({ useSession: () => ({ session: { user: { id: 'u1', name: 'Tester' } } }) }));
vi.mock('./Layout', () => ({
  useOntology: () => ({ id: 'ont_1', ontology: { id: 'ont_1', name: 'Volunteering' }, hasRole: (...r: string[]) => r.some((x) => roles.current.includes(x)) }),
}));
vi.mock('../../components/ChatView', () => ({ ChatView: () => null }));
vi.mock('../../components/UseCaseSharing', () => ({ AnonymisedVersion: () => null, VisibilityPicker: () => null }));

const { InterviewPage } = await import('./Interview');
const render = () => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/o/ont_1/interview/s1']}>
    <InterviewPage />
  </MemoryRouter>,
);

describe('interview page', () => {
  // Show the use case document (the page opens on the conversation otherwise).
  beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'doc', setItem: () => {} }));

  // A contributor reopening a finished interview used to see its drafted SPARQL.
  it('leaves drafted SPARQL tests out for a contributor', () => {
    roles.current = ['contributor'];
    const out = render();
    expect(out).toContain('Which opportunities accept 15-year-olds?');
    expect(out).not.toContain('SELECT');
  });

  it('shows them to an editor', () => {
    roles.current = ['editor'];
    expect(render()).toContain('SELECT');
  });
});
