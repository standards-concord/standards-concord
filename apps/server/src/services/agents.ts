import { compactIRI, NS, OntologyGraph, runCompetencyQuestions, structuralReasoner } from '@concord/core';
import type { AgentReport, AiAnalysis, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { list, mustGet, put } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { AGENT_GAP } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { GapAnalysisSchema } from '../llm/schemas.js';
import { createChangeRequest } from './changeRequests.js';
import { rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { readOntology } from '../public/holds.js';
import { proposalToOps } from './proposals.js';
import { logActivity } from './users.js';

export const getAgentReport = (id: string) => mustGet<AgentReport>('agentReports', id);
export const listAgentReports = (ontologyId: string) =>
  list<AgentReport>('agentReports', ontologyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * A coding agent says the ontology is missing something or does not fit.
 * Triage decides between: use existing terms, a local extension, a change to
 * the ontology (opens a change request), or a question for the community.
 * The answer goes straight back to the agent.
 */
export async function reportGap(
  project: OntologyProject,
  user: User,
  input: { agentName: string; kind: AgentReport['kind']; summary: string; details: string; context?: string },
): Promise<AgentReport> {
  if (!rolesFor(project.id, user.id).length) setRoles(project.id, user.id, ['contributor']);
  const graph = await ontologyStore.working(project);
  const hits = graph.search(`${input.summary} ${input.details}`, 8);
  const c = (iri: string) => compactIRI(iri, graph.prefixes);
  const { value } = await llm.json({
    task: 'agent-gap',
    system: AGENT_GAP,
    schema: GapAnalysisSchema,
    effort: 'medium',
    messages: [
      {
        role: 'user',
        content: `Ontology:\n${ontologyDigest(graph)}\n\nReport from ${input.agentName} (${input.kind}):\nSummary: ${input.summary}\nDetails: ${input.details}\n${input.context ? `Context:\n${input.context}` : ''}`,
      },
    ],
    fallback: () => {
      const existing = hits.map((t) => c(t.iri));
      const covered = hits.length > 0 && input.kind !== 'bug';
      return {
        summary: covered ? `Possibly covered by existing terms: ${existing.slice(0, 4).join(', ')}.` : 'No existing term clearly covers this. Opened for the community to discuss.',
        recommendation: covered ? ('use-existing-terms' as const) : ('needs-discussion' as const),
        existingTerms: existing,
        rationale: covered
          ? `These terms match the words in the report: ${hits
              .slice(0, 4)
              .map((t) => `${c(t.iri)} (${t.label ?? ''}${t.definition ? `: ${t.definition}` : ''})`)
              .join('; ')}. If none fits, define a subclass or subproperty in your own namespace and report back.`
          : 'Editors will review this report. In the meantime, define the term in your application namespace as a subclass or subproperty of the closest ontology term.',
        risks: [],
        suggestedLevel: 'minor' as const,
        terms: [],
      };
    },
  });
  const { terms, ...analysis } = value;
  const report: AgentReport = {
    id: newId('agr'),
    ontologyId: project.id,
    userId: user.id,
    agentName: input.agentName,
    kind: input.kind,
    summary: input.summary,
    details: input.details,
    context: input.context,
    analysis: analysis as AiAnalysis,
    status: 'answered',
    createdAt: clock.iso(),
  };
  if (value.recommendation === 'change-ontology' || value.recommendation === 'needs-discussion' || input.kind === 'bug') {
    const { ops, warnings } = proposalToOps(graph, terms ?? [], `agent report from ${input.agentName}`);
    report.suggestedOps = ops;
    const cr = await createChangeRequest(project, user, {
      title: input.summary.slice(0, 100),
      description: `Reported by the coding agent **${input.agentName}** on behalf of ${user.name}.\n\n${input.details}${input.context ? `\n\n<details><summary>Agent context</summary>\n\n${input.context}\n</details>` : ''}`,
      kind: input.kind === 'bug' ? 'bug' : 'gap',
      origin: { type: 'agent', agentName: input.agentName, reportId: report.id },
      ops,
      warnings,
      analysis: analysis as AiAnalysis,
      // Concrete edits go straight into review; open questions wait as drafts for an editor.
      submit: ops.length > 0,
    });
    report.changeRequestId = cr.id;
    report.status = 'converted';
  }
  put('agentReports', report, project.id);
  logActivity({ ontologyId: project.id, actorId: user.id, type: 'agent.report', message: `${input.agentName} reported: ${input.summary}`, link: `/o/${project.id}/agents` });
  return report;
}

const WELL_KNOWN = [NS.rdf, NS.rdfs, NS.owl, NS.xsd, NS.skos, NS.dcterms, NS.schema, NS.foaf, NS.prov];

/** Check instance data against the ontology: unknown terms, and logical consistency of data + ontology. */
export async function validateData(project: OntologyProject, turtle: string) {
  const graph = await ontologyStore.working(project);
  const data = await OntologyGraph.fromTurtle(turtle);
  const known = new Set<string>();
  for (const q of graph.store.getQuads(null, null, null, null)) known.add(q.subject.value);
  const issues: { severity: 'error' | 'warning'; message: string }[] = [];
  const c = (iri: string) => compactIRI(iri, { ...graph.prefixes, ...data.prefixes });
  const check = (iri: string, what: string) => {
    if (known.has(iri) || WELL_KNOWN.some((ns) => iri.startsWith(ns))) return;
    if (iri.startsWith(graph.namespace)) {
      const t = graph.search(iri.slice(graph.namespace.length), 3);
      issues.push({ severity: 'error', message: `${c(iri)} is used as a ${what} but is not defined in the ontology.${t.length ? ` Did you mean ${t.map((x) => c(x.iri)).join(' or ')}?` : ''}` });
    }
  };
  const RDF_TYPE = `${NS.rdf}type`;
  for (const q of data.store.getQuads(null, null, null, null)) {
    check(q.predicate.value, 'property');
    if (q.predicate.value === RDF_TYPE && q.object.termType === 'NamedNode') check(q.object.value, 'class');
    const term = graph.term(q.predicate.value);
    if (term && term.deprecated) issues.push({ severity: 'warning', message: `${c(q.predicate.value)} is deprecated${term.replacedBy ? `; use ${c(term.replacedBy)} instead` : ''}.` });
  }
  for (const q of data.store.getQuads(null, RDF_TYPE, null, null)) {
    const term = graph.term(q.object.value);
    if (term?.deprecated) issues.push({ severity: 'warning', message: `${c(q.object.value)} is deprecated${term.replacedBy ? `; use ${c(term.replacedBy)} instead` : ''}.` });
  }
  const merged = graph.clone();
  merged.store.addQuads(data.store.getQuads(null, null, null, null));
  const r = structuralReasoner(merged);
  if (!r.consistent) issues.push({ severity: 'error', message: `The data contradicts the ontology: ${r.explanation ?? 'inconsistent'}` });
  return { valid: !issues.some((i) => i.severity === 'error'), triples: data.size, issues: dedupe(issues) };
}

const dedupe = <T extends { message: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.message, x])).values()];

/** Anyone may query; someone not signed in reads only what's published (see readOntology). */
export async function sparql(project: OntologyProject, query: string, ref: string | undefined, viewer: User | undefined) {
  if (!/^\s*(PREFIX[^\n]*\n\s*)*(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i.test(query.replace(/#[^\n]*/g, ''))) {
    return { head: { vars: [] as string[] }, rows: [] as Record<string, string>[], error: 'Only read-only queries (SELECT, ASK, CONSTRUCT, DESCRIBE) are allowed' };
  }
  const graph = await readOntology(project, ref, viewer);
  const [res] = await runCompetencyQuestions(graph, [{ question: 'query', sparql: query }]);
  const vars = res.rows.length ? Object.keys(res.rows[0]) : [];
  return { head: { vars }, rows: res.rows, error: res.error };
}

