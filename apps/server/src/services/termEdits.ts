import type { ChangeOp, TermAnnotations } from '@concord/core/types';
import type { ChangeRequest, OntologyProject, User } from '@concord/shared';
import { TERM_EDIT_FIELDS, type TermEditField, type TermEditInput } from '@concord/shared';
import { HttpError } from '../db.js';
import * as crs from './changeRequests.js';
import { ontologyStore } from './ontologyStore.js';
import { rolesFor, setRoles } from './ontologies.js';

/**
 * Inline edits from a term's page. An edit never writes to the working draft
 * directly: it becomes an editorial change request with one structured
 * `updateAnnotations` op, so it is classified, validated and approved under
 * the ontology's governance policy like any other change.
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

function normalise(field: TermEditField, v: unknown): Value {
  if (isList(field)) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${field} must be a list of strings`);
    const items = [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
    if (items.length > MAX_ITEMS) throw new HttpError(400, `${field} has more than ${MAX_ITEMS} entries`);
    if (items.some((x) => x.length > MAX_TEXT)) throw new HttpError(400, `${field} has an entry longer than ${MAX_TEXT} characters`);
    return items;
  }
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > MAX_TEXT) throw new HttpError(400, `${field} is longer than ${MAX_TEXT} characters`);
  return s;
}

const same = (a: Value, b: Value) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

function listFields(fields: TermEditField[]) {
  const names = fields.map((f) => FIELD_NAMES[f]);
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export async function proposeTermEdit(project: OntologyProject, user: User, input: TermEditInput): Promise<ChangeRequest> {
  if (!input || typeof input.termIri !== 'string' || !input.termIri) throw new HttpError(400, 'termIri is required');
  if (!input.set || typeof input.set !== 'object') throw new HttpError(400, 'set is required');
  const working = await ontologyStore.working(project);
  const term = working.term(input.termIri);
  if (!term) throw new HttpError(404, `No term <${input.termIri}> in the working draft`);

  const current = term as TermAnnotations;
  const set: TermAnnotations = {};
  const changed: TermEditField[] = [];
  const stale: TermEditField[] = [];
  for (const field of TERM_EDIT_FIELDS) {
    if (!(field in input.set)) continue;
    const next = normalise(field, (input.set as Record<string, unknown>)[field]);
    const now = normalise(field, current[field]);
    // The editor sends the values it started from: if someone else has changed
    // the field since, refuse rather than silently overwrite their change.
    if (input.previous && field in input.previous && !same(normalise(field, (input.previous as Record<string, unknown>)[field]), now)) stale.push(field);
    if (same(next, now)) continue;
    changed.push(field);
    (set as Record<string, Value>)[field] = next;
  }
  if (stale.length) throw new HttpError(409, `The ${listFields(stale)} of this term changed since you opened the editor. Reload the term and make your edit again.`);
  if (!changed.length) throw new HttpError(400, 'Nothing to change: the values are the same as the working draft');
  if (changed.includes('label') && !set.label) throw new HttpError(400, 'The label cannot be empty');

  if (!rolesFor(project.id, user.id).length) setRoles(project.id, user.id, ['contributor']);
  const name = term.label ?? input.termIri;
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_TEXT) : '';
  const op: ChangeOp = { op: 'updateAnnotations', iri: input.termIri, set };
  return crs.createChangeRequest(project, user, {
    title: `Edit the ${listFields(changed)} of “${name}”`,
    description: [reason, `Edited on the page for <${input.termIri}>.`].filter(Boolean).join('\n\n'),
    kind: 'editorial',
    origin: { type: 'term-edit', termIri: input.termIri },
    ops: [op],
    submit: !!input.submit,
  });
}
