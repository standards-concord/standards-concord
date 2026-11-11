import { Parser, Store } from 'n3';
import { Parser as SparqlParser } from 'sparqljs';
import type { OntologyGraph } from './graph.js';
import { runCompetencyQuestions, withPrefixes, type CompetencyQuestion } from './cq.js';
import { sha256Hex } from './canon.js';
import { writeNTriples } from './turtle.js';

export interface WorkedExample {
  id: string;
  slug: string;
  question: string;
  source: string;
  sparql: string;
  exampleData: string;
  exampleAnswer: string;
  answered: boolean;
  result: { variables: string[]; rows: Record<string, string>[]; totalCount: number; boolean?: boolean; error?: string };
  queryFile: string;
}

/** Runs each question against its own data and keeps a small answer for readers. */
export async function workedExamples(graph: OntologyGraph, questions: CompetencyQuestion[]): Promise<WorkedExample[]> {
  const results = await runCompetencyQuestions(graph, questions);
  return Promise.all(questions.map(async (q, i) => {
    const r = results[i];
    const sparql = withPrefixes(q.sparql, graph.prefixes);
    let variables = [...new Set(r.rows.flatMap((row) => Object.keys(row)))];
    let ask = false;
    try {
      const parsed = new SparqlParser().parse(sparql);
      if (parsed.type === 'query') {
        ask = parsed.queryType === 'ASK';
        if (parsed.queryType === 'SELECT') {
          const projected = parsed.variables.flatMap((v) => 'termType' in v && v.termType === 'Variable' ? [v.value] : 'variable' in v ? [v.variable.value] : []);
          if (projected.length) variables = projected;
        }
      }
    } catch {
      // The runner records unreadable queries below.
    }
    const key = `${q.source ?? ''}:${q.id ?? q.question + ':' + q.sparql}`;
    const id = `example-${(await sha256Hex(key)).slice(0, 16)}`;
    const slug = `${q.question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'question'}-${id.slice(8)}`;
    return {
      id, slug, question: q.question, source: q.source ?? '', sparql,
      exampleData: q.exampleData ?? '', exampleAnswer: q.exampleAnswer ?? '', answered: r.satisfied,
      result: {
        variables: ask ? [] : variables, rows: ask ? [] : r.rows.slice(0, 20), totalCount: ask ? 0 : r.rows.length,
        ...(ask && r.ok ? { boolean: r.satisfied } : {}), ...(r.error ? { error: r.error } : {}),
      },
      queryFile: `examples/${i + 1}-${slug}.rq`,
    };
  }));
}

/** Parses each document separately so its prefixes, base and blank nodes stay local. */
export function exampleData(examples: WorkedExample[], baseIRI?: string): string {
  const store = new Store();
  for (const e of examples) {
    try {
      store.addQuads(new Parser({ baseIRI, blankNodePrefix: `${e.id}_` }).parse(e.exampleData));
    } catch {
      // An unreadable example still has its question and error, but cannot join the data file.
    }
  }
  return writeNTriples(store);
}

export function exampleFiles(examples: WorkedExample[], baseIRI?: string): Record<string, string> {
  return {
    'examples.json': `${JSON.stringify(examples, null, 2)}\n`,
    'examples/data.ttl': exampleData(examples, baseIRI),
    ...Object.fromEntries(examples.map((e) => [e.queryFile, `${e.sparql}\n`])),
  };
}
