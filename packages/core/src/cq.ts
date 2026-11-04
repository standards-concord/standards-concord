/**
 * Competency questions (Grüninger & Fox): SPARQL queries run against the ontology
 * plus example data in an in-memory Oxigraph store, and whole-ontology validation.
 */
import type { CompetencyQuestionResult, FairContext, ValidationReport } from './types.js';
import type { OntologyGraph } from './graph.js';
import { writeNTriples } from './turtle.js';
import { lint } from './lint.js';
import { fairCheck } from './fair.js';
import { owlReasoner, structuralReasoner } from './reasoner.js';

export interface CompetencyQuestion {
  question: string;
  sparql: string;
  exampleData?: string;
  /** Where the question came from (a use case id), carried onto its result so readers can check who may see it. */
  source?: string;
}

/** Adds PREFIX declarations for the graph's prefixes that the query uses but does not declare. */
export function withPrefixes(sparql: string, prefixes: Record<string, string>): string {
  const declared = new Set([...sparql.matchAll(/PREFIX\s+([A-Za-z][\w.-]*)?:/gi)].map((m) => m[1] ?? ''));
  const lines = Object.entries(prefixes)
    .filter(([p]) => !declared.has(p) && p !== '' && new RegExp(`(^|[\\s(,/^|!{;])${p.replace(/[.-]/g, '\\$&')}:`).test(sparql.replace(/<[^>]*>/g, '')))
    .map(([p, ns]) => `PREFIX ${p}: <${ns}>`);
  return lines.length ? lines.join('\n') + '\n' + sparql : sparql;
}

export async function runCompetencyQuestions(graph: OntologyGraph, cqs: CompetencyQuestion[]): Promise<CompetencyQuestionResult[]> {
  const ox = await import('oxigraph');
  const Store = (ox as any).Store ?? (ox as any).default?.Store;
  const ontology = writeNTriples(graph.store);
  const results: CompetencyQuestionResult[] = [];
  for (const cq of cqs) {
    const base: CompetencyQuestionResult = { question: cq.question, sparql: cq.sparql, ok: false, rows: [], satisfied: false, ...(cq.source ? { source: cq.source } : {}) };
    try {
      const store = new Store();
      store.load(ontology, { format: 'application/n-triples' });
      if (cq.exampleData?.trim()) store.load(cq.exampleData, { format: 'text/turtle', base_iri: graph.ontologyIRI || undefined });
      const res = store.query(withPrefixes(cq.sparql, graph.prefixes));
      let rows: Record<string, string>[] = [];
      let satisfied: boolean;
      if (typeof res === 'boolean') {
        satisfied = res;
        rows = [{ result: String(res) }];
      } else if (Array.isArray(res)) {
        rows = res.map((r: any) => {
          // SELECT solutions are Maps; CONSTRUCT/DESCRIBE results are quads.
          if (r instanceof Map) return Object.fromEntries([...r.entries()].map(([k, v]: [string, any]) => [k, v.value]));
          return { subject: r.subject.value, predicate: r.predicate.value, object: r.object.value };
        });
        satisfied = rows.length > 0;
      } else {
        satisfied = false;
      }
      results.push({ ...base, ok: true, rows, satisfied });
    } catch (e) {
      results.push({ ...base, error: (e as Error).message ?? String(e) });
    }
  }
  return results;
}

export interface ValidateOptions {
  cqs?: CompetencyQuestion[];
  reasoner?: 'owl' | 'structural';
  /** Network facts for the FAIR checks (whether the ontology IRI resolves). */
  fair?: FairContext;
}

/** Strict lint + FAIR + reasoner (+ CQs). Passes when lint has no errors and the ontology is coherent. */
export async function validate(graph: OntologyGraph, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const issues = lint(graph, { strict: true });
  const fair = fairCheck(graph, opts.fair);
  const reasoner = opts.reasoner === 'structural' ? structuralReasoner(graph) : await owlReasoner(graph);
  const competencyQuestions = opts.cqs?.length ? await runCompetencyQuestions(graph, opts.cqs) : [];
  const passed = !issues.some((i) => i.severity === 'error') && reasoner.consistent && reasoner.unsatisfiable.length === 0;
  return { lint: issues, fair, reasoner, competencyQuestions, passed };
}
