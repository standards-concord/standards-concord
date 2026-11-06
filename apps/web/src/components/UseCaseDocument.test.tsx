import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UseCase } from '@concord/shared';
import { CompetencyQuestions, UseCaseDocument } from './UseCaseDocument';

const uc = {
  id: 'uc_1',
  competencyQuestions: [{ id: 'cq1', question: 'Which opportunities accept 15-year-olds?', exampleAnswer: 'Park clean-up', sparql: 'SELECT ?o WHERE { ?o a :Opportunity }', status: 'answerable' }],
  terms: [],
} as unknown as UseCase;

describe('CompetencyQuestions', () => {
  // A page that forgot to pass a role (the interview page did) showed drafted SPARQL to everyone.
  it('leaves out SPARQL tests unless asked to show them', () => {
    for (const compact of [false, true]) {
      const out = renderToStaticMarkup(<CompetencyQuestions uc={uc} compact={compact} />);
      expect(out).toContain('Which opportunities accept 15-year-olds?');
      expect(out).not.toContain('SPARQL test');
      expect(out).not.toContain('SELECT');
    }
  });

  it('leaves them out of a whole use case document unless asked, open or collapsible', () => {
    for (const collapsible of [false, true]) {
      const out = renderToStaticMarkup(<UseCaseDocument uc={uc} collapsible={collapsible} />);
      expect(out).toContain('Which opportunities accept 15-year-olds?');
      expect(out).not.toContain('SELECT');
    }
    expect(renderToStaticMarkup(<UseCaseDocument uc={uc} showQueries />)).toContain('SELECT');
  });

  it('shows SPARQL tests when asked (for editors)', () => {
    const out = renderToStaticMarkup(<CompetencyQuestions uc={uc} showQueries />);
    expect(out).toContain('SPARQL test');
    expect(out).toContain('SELECT');
  });
});
