import * as z from 'zod';
import { applyChangeOps, diffOntologies, expandIRI, sameAnnotationValue } from '@concord/core';
import type { CodeListOp, ConceptAnnotations, OntologyGraph } from '@concord/core';
import type { ChangeRequest, CodeListEditInput, OntologyProject, User } from '@concord/shared';
import { HttpError } from '../db.js';
import { withTriageBudget } from './budget.js';
import * as crs from './changeRequests.js';
import { ontologyStore } from './ontologyStore.js';
import { rolesFor, setRoles } from './ontologies.js';

const text = z.string().trim().max(4000);
const required = text.min(1);
// Accept full IRIs or CURIEs, like the core engine. Resolution is checked by the dry run.
const isIRI = (v: string) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(v);
const iri = required.refine(isIRI, 'Expected an IRI or CURIE');
const list = z.array(required).max(50);
const annotations = z.object({
  label: required.optional(), definition: text.optional(), notation: text.optional(),
  altLabels: list.optional(), examples: list.optional(), editorialNote: text.optional(),
}).strict();
// Existing imported values may exceed editor limits; let authors shorten them.
// The request-body limit still bounds the complete payload.
const baselineText = z.string().trim();
const previousAnnotations = z.object({
  label: baselineText.optional(), definition: baselineText.optional(), notation: baselineText.optional(),
  altLabels: z.array(baselineText).optional(), examples: z.array(baselineText).optional(), editorialNote: baselineText.optional(),
}).strict();
const newFields = { localName: required, label: required, definition: required, altLabels: list.optional(), editorialNote: text.optional(), source: list.optional() };
export const CodeListEditSchema = z.object({
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('addConceptScheme'), ...newFields }).strict(),
    z.object({ op: z.literal('addConcept'), ...newFields, scheme: iri, notation: text.optional(), broader: iri.optional(), examples: list.optional() }).strict(),
    z.object({ op: z.literal('updateConcept'), iri, set: annotations.refine((v) => Object.keys(v).length > 0, 'set must contain a field'), previous: previousAnnotations.optional(), definitionIntent: z.enum(['same-meaning', 'new-meaning']).optional() }).strict(),
    z.object({ op: z.literal('moveConcept'), iri, broader: iri.nullable(), previous: z.object({ broader: baselineText.min(1).refine(isIRI, 'Expected an IRI or CURIE').nullable() }).strict().optional() }).strict(),
    z.object({ op: z.literal('deprecateConcept'), iri, reason: required, replacedBy: iri.optional() }).strict(),
    z.object({ op: z.literal('setCodeList'), property: iri, scheme: iri.nullable() }).strict(),
  ])).min(1).max(50),
  reason: text.optional(), submit: z.boolean().optional(),
}).strict();

/** The primary scheme is used for navigation; a request can also edit other lists. */
function schemeOf(g: OntologyGraph, op: CodeListOp): string | undefined {
  const ex = (iri: string) => expandIRI(iri, g.prefixes);
  if (op.op === 'addConceptScheme') return g.namespace + op.localName;
  if (op.op === 'addConcept') return ex(op.scheme);
  if (op.op === 'setCodeList') {
    const property = g.term(ex(op.property));
    return op.scheme ? ex(op.scheme) : property && 'codeList' in property ? property.codeList : undefined;
  }
  const term = g.term(ex(op.iri));
  return term?.kind === 'conceptScheme' ? term.iri : term?.kind === 'concept' ? term.inScheme[0] : undefined;
}

export async function proposeCodeListEdit(project: OntologyProject, user: User, raw: CodeListEditInput): Promise<ChangeRequest> {
  const parsed = CodeListEditSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data;
  const working = await ontologyStore.working(project);
  let draft = working;
  const ops: CodeListOp[] = [];
  let scheme: string | undefined;
  const schemes = new Set<string>();
  let meaningChange: { level: 'major'; rule: string; iri: string; message: string } | undefined;
  for (const incoming of input.ops) {
    let op: CodeListOp;
    if (incoming.op === 'updateConcept') {
      const term = draft.term(expandIRI(incoming.iri, draft.prefixes));
      if (term?.kind !== 'concept' && term?.kind !== 'conceptScheme') throw new HttpError(400, `<${incoming.iri}> is not a code or code list`);
      const expect: ConceptAnnotations = {};
      for (const field of Object.keys(incoming.set) as (keyof ConceptAnnotations)[]) {
        const now = field === 'notation' ? term.kind === 'concept' ? term.notation : undefined : term[field];
        if (incoming.previous && field in incoming.previous && !sameAnnotationValue(incoming.previous[field], now)) throw new HttpError(409, `The ${field} of this code or code list changed since you opened the editor. Reload the latest values and make your edit again.`);
        Object.assign(expect, { [field]: now ?? (field === 'altLabels' || field === 'examples' ? [] : '') });
      }
      op = { op: 'updateConcept', iri: term.iri, set: incoming.set, expect };
      if (incoming.definitionIntent === 'new-meaning' && incoming.set.definition !== undefined && term.definition && !sameAnnotationValue(term.definition, incoming.set.definition)) meaningChange = { level: 'major', rule: 'meaning-changed', iri: term.iri, message: `the author says the new definition of ${term.label ?? term.iri} changes what it means` };
    } else if (incoming.op === 'moveConcept') {
      const term = draft.term(expandIRI(incoming.iri, draft.prefixes));
      if (term?.kind !== 'concept') throw new HttpError(400, `<${incoming.iri}> is not a code`);
      const broader = term.broader[0] ?? null;
      if (incoming.previous && broader !== (incoming.previous.broader === null ? null : expandIRI(incoming.previous.broader, draft.prefixes))) {
        throw new HttpError(409, 'The parent of this code changed since you opened the editor. Reload the latest values and make your edit again.');
      }
      op = { op: 'moveConcept', iri: term.iri, broader: incoming.broader, expect: { broader } };
    } else op = incoming;
    const affected = schemeOf(draft, op);
    if (affected) schemes.add(affected);
    scheme ??= affected;
    try {
      draft = applyChangeOps(draft, [op]).graph;
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    ops.push(op);
  }
  if (!scheme) throw new HttpError(400, 'No code list to edit');
  const diff = diffOntologies(working, draft);
  if (!diff.addedTriples && !diff.removedTriples) throw new HttpError(400, 'Nothing to change: the values are the same as the working draft');
  const name = working.term(scheme)?.label ?? draft.term(scheme)?.label ?? scheme;
  const addedSchemes = ops.filter((o) => o.op === 'addConceptScheme');
  const addedCodes = ops.filter((o) => o.op === 'addConcept');
  const first = ops[0];
  const firstTerm = 'iri' in first ? working.term(expandIRI(first.iri, draft.prefixes)) ?? draft.term(expandIRI(first.iri, draft.prefixes)) : undefined;
  const title = schemes.size > 1
    ? `Edit ${schemes.size} code lists`
    : addedSchemes.length === 1
    ? `Create the code list “${name}”`
    : addedCodes.length && addedCodes.length === ops.length
      ? `Add ${addedCodes.length} ${addedCodes.length === 1 ? 'code' : 'codes'} to “${name}”`
      : ops.length === 1 && 'iri' in first
        ? `Edit the ${firstTerm?.kind === 'conceptScheme' ? 'code list' : 'code'} “${firstTerm?.label ?? first.iri}”`
        : `Edit the code list “${name}”`;
  return withTriageBudget(user, async () => {
    if (!(await rolesFor(project.id, user.id)).length) await setRoles(project.id, user.id, ['contributor']);
    return crs.createChangeRequest(project, user, {
      title, description: input.reason ?? '', kind: 'editorial',
      origin: { type: 'code-list-edit', scheme }, ops, submit: input.submit ?? false,
      declaredLevel: meaningChange,
    });
  });
}
