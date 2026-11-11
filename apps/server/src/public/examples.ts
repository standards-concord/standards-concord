import { createHash } from 'node:crypto';
import { workedExamples, type OntologyGraph, type WorkedExample } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { competencyTests } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { withdrawnSince } from '../services/requirements.js';

export const EXAMPLES_SNAPSHOT = 'examples.json';
const cache = new Map<string, Promise<WorkedExample[]>>();

/** Only public questions enter the cache; changing either the graph or questions changes its key. */
export async function liveExamples(project: OntologyProject, graph: OntologyGraph): Promise<WorkedExample[]> {
  const questions = await competencyTests(project.id, { published: true });
  // Turtle drops prefixes the ontology doesn't use, but queries may rely on them (withPrefixes), so they are part of the key.
  const prefixes = Object.entries(graph.prefixes).sort(([a], [b]) => a.localeCompare(b));
  const digest = createHash('sha256').update(await graph.toTurtle()).update(JSON.stringify(prefixes)).update(JSON.stringify(questions)).digest('hex');
  const key = `${project.id}:${digest}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = workedExamples(graph, questions);
    // Keep one draft per ontology.
    for (const k of cache.keys()) if (k.startsWith(`${project.id}:`)) cache.delete(k);
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

/** Unreadable or absent snapshots never fall back to today's questions. */
export async function examplesSnapshot(project: OntologyProject, version: string): Promise<WorkedExample[] | undefined> {
  const text = await ontologyStore.readReleaseFile(project, version, EXAMPLES_SNAPSHOT);
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || !data.every(validExample)) return [];
    return data;
  } catch {
    return [];
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string';

function validExample(e: unknown): e is WorkedExample {
  if (!isObject(e) || !isObject(e.result)) return false;
  const r = e.result;
  return ['id', 'slug', 'question', 'source', 'sparql', 'exampleData', 'exampleAnswer'].every((k) => isString(e[k])) &&
    isString(e.queryFile) && /^examples\/[0-9]+-[a-z0-9-]+\.rq$/.test(e.queryFile) && typeof e.answered === 'boolean' &&
    Array.isArray(r.variables) && r.variables.every(isString) &&
    Array.isArray(r.rows) && r.rows.every((row) => isObject(row) && Object.values(row).every(isString)) &&
    typeof r.totalCount === 'number' && Number.isSafeInteger(r.totalCount) && r.totalCount >= 0 &&
    (r.boolean === undefined || typeof r.boolean === 'boolean') && (r.error === undefined || isString(r.error));
}

/** Apply today's consent to every file and page, including frozen releases. */
export async function visibleExamples(project: OntologyProject, examples: WorkedExample[]): Promise<WorkedExample[]> {
  const gone = await withdrawnSince(project.id, [...new Set(examples.map((e) => e.source))]);
  return examples.filter((e) => !gone.has(e.source));
}

export async function examplesFor(project: OntologyProject, version: string, graph: OntologyGraph): Promise<WorkedExample[]> {
  return visibleExamples(project, version === 'draft' ? await liveExamples(project, graph) : await examplesSnapshot(project, version) ?? []);
}
