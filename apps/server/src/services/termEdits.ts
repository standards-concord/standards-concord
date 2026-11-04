import { sameAnnotationValue } from '@concord/core';
import type { ChangeOp, TermAnnotations } from '@concord/core/types';
import type { ChangeRequest, OntologyProject, User } from '@concord/shared';
import { TERM_EDIT_FIELDS, type TermEditField, type TermEditInput } from '@concord/shared';
import { HttpError } from '../db.js';
import { withTriageBudget } from './budget.js';
import * as crs from './changeRequests.js';
import { ontologyStore } from './ontologyStore.js';
import { rolesFor, setRoles } from './ontologies.js';

/**
 * Inline edits from a term's page. An edit never writes to the working draft
 * directly: it becomes an editorial change request with one structured
 * `updateAnnotations` op, so it is classified, validated and approved under
 * the ontology's governance policy like any other change.
 *
 * The op carries the values the edit was based on (`expect`), so if another
 * change to the same fields merges first, this one fails to apply at merge and
 * goes back to its author instead of silently overwriting the other.
 */

type Value = string | string[];

const MAX_TEXT = 4000;
const MAX_ITEMS = 50;

const FIELD_NAMES: Record<TermEditField, string> = {
  label: 'label',
  definition: 'definition',
  comment: 'comment',
  altLabels: 'alternative labels',
  examples: 'examples',
  editorialNote: 'editorial note',
};

const isList = (f: TermEditField) => f === 'altLabels' || f === 'examples';

/** A value from the request body: type-checked and size-limited. */
function fromInput(field: TermEditField, v: unknown, limit: boolean): Value {
  if (isList(field)) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${field} must be a list of strings`);
    const items = [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
    if (limit && items.length > MAX_ITEMS) throw new HttpError(400, `${field} has more than ${MAX_ITEMS} entries`);
    if (limit && items.some((x) => x.length > MAX_TEXT)) throw new HttpError(400, `${field} has an entry longer than ${MAX_TEXT} characters`);
    return items;
  }
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (limit && s.length > MAX_TEXT) throw new HttpError(400, `${field} is longer than ${MAX_TEXT} characters`);
  return s;
}

/** A value as stored in the graph. Never size-limited, so oversized legacy text can still be shortened. */
function stored(field: TermEditField, v: unknown): Value {
  if (isList(field)) return Array.isArray(v) ? v.map(String) : [];
  return typeof v === 'string' ? v : '';
}

function listFields(fields: TermEditField[]) {
  const names = fields.map((f) => FIELD_NAMES[f]);
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export async function proposeTermEdit(project: OntologyProject, user: User, input: TermEditInput): Promise<ChangeRequest> {
  if (!input || typeof input.termIri !== 'string' || !input.termIri) throw new HttpError(400, 'termIri is required');
  if (!input.set || typeof input.set !== 'object') throw new HttpError(400, 'set is required');
  if (input.definitionIntent !== undefined && !['same-meaning', 'new-meaning'].includes(input.definitionIntent)) throw new HttpError(400, 'definitionIntent must be same-meaning or new-meaning');
  const working = await ontologyStore.working(project);
  const term = working.term(input.termIri);
  if (!term) throw new HttpError(404, `No term <${input.termIri}> in the working draft`);

  const current = term as TermAnnotations;
  const set: Record<string, Value> = {};
  const expect: Record<string, Value> = {};
  const changed: TermEditField[] = [];
  const stale: TermEditField[] = [];
  const setIn = input.set as Record<string, unknown>;
  const previousIn = (input.previous ?? {}) as Record<string, unknown>;
  for (const field of TERM_EDIT_FIELDS) {
    if (!(field in setIn)) continue;
    const next = fromInput(field, setIn[field], true);
    const now = stored(field, current[field]);
    // The editor sends the values it started from: if someone else has changed
    // the field since, refuse rather than silently overwrite their change.
    if (field in previousIn && !sameAnnotationValue(fromInput(field, previousIn[field], false), now)) stale.push(field);
    if (sameAnnotationValue(next, now)) continue;
    changed.push(field);
    set[field] = next;
    expect[field] = now;
  }
  if (stale.length) throw new HttpError(409, `The ${listFields(stale)} of this term changed since you opened the editor. Reload the latest values and make your edit again.`);
  if (!changed.length) throw new HttpError(400, 'Nothing to change: the values are the same as the working draft');
  if (changed.includes('label') && !set.label) throw new HttpError(400, 'The label cannot be empty');

  // Rewording an existing definition must say whether the meaning is kept:
  // OBO principle 19 treats a change of meaning as a different term.
  const rewordsDefinition = changed.includes('definition') && !!expect.definition && !!set.definition;
  if (rewordsDefinition && !input.definitionIntent) throw new HttpError(400, 'Say whether the new definition keeps the term’s meaning (definitionIntent: same-meaning or new-meaning)');
  const intent = rewordsDefinition ? input.definitionIntent : undefined;

  return withTriageBudget(user.id, async () => {
    if (!rolesFor(project.id, user.id).length) setRoles(project.id, user.id, ['contributor']);
    const name = term.label ?? input.termIri;
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_TEXT) : '';
    const intentNote =
      intent === 'same-meaning'
        ? 'The author confirms the new definition keeps the term’s meaning: it refers to exactly the same things.'
        : intent === 'new-meaning'
          ? 'The author says the new definition **changes what the term means**, so this is reviewed as a major change. Consider adding a new term and deprecating this one instead.'
          : '';
    const op: ChangeOp = { op: 'updateAnnotations', iri: input.termIri, set, expect };
    return crs.createChangeRequest(project, user, {
      title: `Edit the ${listFields(changed)} of “${name}”`,
      description: [reason, intentNote, `Edited on the page for <${input.termIri}>.`].filter(Boolean).join('\n\n'),
      kind: 'editorial',
      origin: { type: 'term-edit', termIri: input.termIri },
      ops: [op],
      submit: !!input.submit,
      declaredLevel:
        intent === 'new-meaning'
          ? { level: 'major', rule: 'meaning-changed', iri: input.termIri, message: `the author says the new definition of ${name} changes what it means` }
          : undefined,
    });
  });
}
