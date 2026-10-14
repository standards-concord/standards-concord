import { compactIRI, type OntologyGraph } from '@concord/core';
import type { Restriction, TermView } from '@concord/core/types';
import type { UseCase } from '@concord/shared';

/** A compact, model-friendly rendering of an ontology (Manchester-ish one-liners). */
export function ontologyDigest(graph: OntologyGraph, maxTerms = 400): string {
  const v = graph.view();
  const c = (iri: string) => compactIRI(iri, v.prefixes);
  const r = (x: Restriction) => `${c(x.property)} ${x.kind}${x.cardinality !== undefined ? ` ${x.cardinality}` : ''} ${x.filler ? c(x.filler) : (x.literal ?? '')}`.trim();
  const line = (t: TermView) => {
    const dep = t.deprecated ? ' [DEPRECATED' + (t.replacedBy ? ` → ${c(t.replacedBy)}` : '') + ']' : '';
    const def = t.definition ? ` — ${t.definition}` : '';
    if (t.kind === 'class') {
      const sup = [...t.superClasses.map(c), ...t.restrictions.map(r)];
      return `Class ${c(t.iri)} "${t.label ?? ''}"${sup.length ? ` ⊑ ${sup.join(' and ')}` : ''}${t.disjointWith.length ? ` disjoint ${t.disjointWith.map(c).join(',')}` : ''}${dep}${def}`;
    }
    if (t.kind === 'individual') return `Individual ${c(t.iri)} "${t.label ?? ''}" : ${t.types.map(c).join(', ')}${dep}`;
    const kind = t.kind === 'objectProperty' ? 'ObjectProperty' : t.kind === 'datatypeProperty' ? 'DataProperty' : 'AnnotationProperty';
    return `${kind} ${c(t.iri)} "${t.label ?? ''}" ${t.domain.map(c).join('|') || '⊤'} → ${t.range.map(c).join('|') || '⊤'}${t.characteristics.length ? ` (${t.characteristics.join(',')})` : ''}${dep}${def}`;
  };
  const terms: TermView[] = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.individuals];
  const prefixes = Object.entries(v.prefixes)
    .map(([p, ns]) => `@prefix ${p}: <${ns}> .`)
    .join('\n');
  return `${prefixes}

Ontology <${v.metadata.iri}> "${v.metadata.title ?? ''}" version ${v.metadata.versionInfo ?? 'unreleased'}
Namespace: ${graph.namespace}
${v.metadata.description ?? ''}

${terms.slice(0, maxTerms).map(line).join('\n')}${terms.length > maxTerms ? `\n… and ${terms.length - maxTerms} more terms` : ''}`;
}

export function useCaseDigest(u: UseCase): string {
  const s = u.sections;
  const parts = [
    `## Use case: ${s.name ?? '(unnamed)'} [${u.id}]`,
    s.goal && `Goal: ${s.goal}`,
    s.actors && `Actors: ${s.actors}`,
    s.stakeholders && `Stakeholders: ${s.stakeholders}`,
    s.description && `Description: ${s.description}`,
    s.scope && `Scope: ${s.scope}`,
    s.requirements && `Requirements: ${s.requirements}`,
    s.usageScenarios?.length && `Scenarios:\n${s.usageScenarios.map((x) => `- ${x}`).join('\n')}`,
    s.basicFlow?.length && `Basic flow:\n${s.basicFlow.map((x) => `${x.step}. [${x.actorPerson ?? x.actorSystem ?? ''}] ${x.description}`).join('\n')}`,
    s.dataSources?.length && `Data sources: ${s.dataSources.map((d) => d.name + (d.description ? ` (${d.description})` : '')).join('; ')}`,
    s.externalOntologies?.length && `Existing vocabularies: ${s.externalOntologies.map((d) => d.name).join('; ')}`,
    s.openIssues && `Open issues: ${s.openIssues}`,
    u.competencyQuestions.length &&
      `Competency questions:\n${u.competencyQuestions.map((q) => `- ${q.question}${q.exampleAnswer ? ` (example answer: ${q.exampleAnswer})` : ''}`).join('\n')}`,
    u.terms.length &&
      `Candidate terms:\n${u.terms.map((t) => `- ${t.label} (${t.kind})${t.definition ? `: ${t.definition}` : ''}${t.evidence?.length ? ` — “${t.evidence[0]}”` : ''}`).join('\n')}`,
  ];
  return parts.filter(Boolean).join('\n');
}
