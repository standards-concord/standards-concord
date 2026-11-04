import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ChangeRequest, ChangeRequestDetail, TermEditField, TermEditValues } from '@concord/shared';
import { TERM_EDIT_FIELDS } from '@concord/shared';
import type { TermView } from '@concord/core/types';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { CR_STATUS_LABEL, LevelBadge } from './badges';
import { ruleSummary } from '../pages/ontology/Governance';
import { useOntology } from '../pages/ontology/Layout';
import { Button, Field, InlineError, Input, Textarea } from './ui';

/**
 * Inline editor for a term's annotations (label, definition, comment, alternative
 * labels, examples, editorial note). Saving never edits the working draft: it
 * opens an editorial change request, which the ontology's governance policy
 * then classifies, validates and approves like any other change.
 */

type Form = Record<TermEditField, string>;

const OPEN_STATUSES = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'];
const LIST_FIELDS: TermEditField[] = ['altLabels', 'examples'];
const FIELD_LABEL: Record<TermEditField, string> = {
  label: 'Label',
  definition: 'Definition',
  comment: 'Comment',
  altLabels: 'Also known as',
  examples: 'Examples',
  editorialNote: 'Editorial note',
};

const isList = (f: TermEditField) => LIST_FIELDS.includes(f);
const toLines = (s: string) => [...new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))];

function formFrom(t: TermView): Form {
  return {
    label: t.label ?? '',
    definition: t.definition ?? '',
    comment: t.comment ?? '',
    altLabels: (t.altLabels ?? []).join('\n'),
    examples: (t.examples ?? []).join('\n'),
    editorialNote: t.editorialNote ?? '',
  };
}

function valueOf(f: TermEditField, s: string): string | string[] {
  return isList(f) ? toLines(s) : s.trim();
}

const same = (a: string | string[], b: string | string[]) => JSON.stringify(a) === JSON.stringify(b);

/** Open change requests that already touch this term, so people don't propose the same edit twice. */
function useOpenRequestsFor(ontologyId: string, iri: string) {
  const all = useAsync(() => api.changeRequests(ontologyId), [ontologyId]);
  return useMemo(
    () => (all.data ?? []).filter((c) => OPEN_STATUSES.includes(c.status) && (JSON.stringify(c.ops).includes(JSON.stringify(iri)) || (c.origin.type === 'term-edit' && c.origin.termIri === iri))),
    [all.data, iri],
  );
}

export function TermEditForm({ term, termLabel, onCancel, onProposed }: { term: TermView; termLabel: string; onCancel: () => void; onProposed: (cr: ChangeRequestDetail) => void }) {
  const { id, ontology } = useOntology();
  const initial = useMemo(() => formFrom(term), [term]);
  const [form, setForm] = useState<Form>(initial);
  const [reason, setReason] = useState('');
  const others = useOpenRequestsFor(id, term.iri);

  const changed = TERM_EDIT_FIELDS.filter((f) => !same(valueOf(f, form[f]), valueOf(f, initial[f])));
  const labelEmpty = !form.label.trim();
  const removesKeyText = (['label', 'definition'] as const).filter((f) => changed.includes(f) && initial[f].trim() && !form[f].trim());
  const patchRule = ontology.governance?.changes?.patch;

  const save = useAction(async (submit: boolean) => {
    const set: TermEditValues = {};
    const previous: TermEditValues = {};
    for (const f of changed) {
      (set as Record<string, unknown>)[f] = valueOf(f, form[f]);
      (previous as Record<string, unknown>)[f] = valueOf(f, initial[f]);
    }
    const cr = await api.proposeTermEdit(id, { termIri: term.iri, set, previous, reason: reason.trim() || undefined, submit });
    onProposed(cr);
  });

  const field = (f: TermEditField, rows: number, hint?: string) => {
    const label = (
      <>
        {FIELD_LABEL[f]}
        {changed.includes(f) && <span className="ml-2 text-xs font-normal text-accent">changed</span>}
      </>
    );
    return (
      <Field label={label} hint={hint}>
        {rows === 1 ? (
          <Input value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} aria-invalid={f === 'label' && labelEmpty} />
        ) : (
          <Textarea rows={rows} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
        )}
      </Field>
    );
  };

  return (
    <form
      className="space-y-4"
      aria-label={`Edit ${termLabel}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length && !labelEmpty) void save.run(true);
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">Edit “{termLabel}”</h2>
        <p className="mt-1 text-sm text-muted">
          Your edit is proposed as a change request; the published ontology and the working draft stay as they are until it is approved and merged.
          {patchRule && <> Wording changes are patch changes here: {ruleSummary(patchRule)}.</>}
        </p>
      </div>

      {others.length > 0 && (
        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          <span className="font-medium">Already proposed for this term:</span>{' '}
          {others.map((c: ChangeRequest, i) => (
            <span key={c.id}>
              <Link className="text-accent hover:underline" to={`/o/${id}/changes/${c.id}`}>
                #{c.number} {c.title}
              </Link>{' '}
              <span className="text-muted">({CR_STATUS_LABEL[c.status]})</span>
              {i < others.length - 1 && ', '}
            </span>
          ))}
        </div>
      )}

      {field('label', 1)}
      {labelEmpty && <p className="-mt-2 text-xs text-danger">A term needs a label.</p>}
      {field('definition', 3, 'Strict OWL practice: genus and differentia, e.g. “A person who …”.')}
      {field('comment', 2)}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('altLabels', 2, 'One per line.')}
        {field('examples', 2, 'One per line.')}
      </div>
      {field('editorialNote', 2)}

      <Field label="Why this change? (optional)" hint="Shown to reviewers with the change request.">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {removesKeyText.length > 0 && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm">
          Removing the {removesKeyText.join(' and ')} of an existing term is a <LevelBadge level="major" className="mx-0.5" /> change, so it needs the stricter sign-off.
        </p>
      )}

      <InlineError error={save.error} />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <span className="mr-auto text-xs text-muted">{changed.length ? `Changing: ${changed.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ')}` : 'No changes yet'}</span>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={save.pending}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" disabled={!changed.length || labelEmpty || save.pending} onClick={() => void save.run(false)}>
          Save as draft
        </Button>
        <Button type="submit" variant="primary" loading={save.pending} disabled={!changed.length || labelEmpty}>
          Propose change
        </Button>
      </div>
    </form>
  );
}

/** Shown on the term page after an edit is proposed, until the reader moves on. */
export function ProposedEditNotice({ cr, onDismiss }: { cr: ChangeRequestDetail; onDismiss: () => void }) {
  const draft = cr.status === 'draft';
  return (
    <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-accent-soft px-3 py-2 text-sm">
      <span>
        {draft ? 'Saved as draft' : 'Proposed as'}{' '}
        <Link className="font-medium text-accent hover:underline" to={`/o/${cr.ontologyId}/changes/${cr.id}`}>
          change request #{cr.number}
        </Link>
        {cr.classification && <LevelBadge level={cr.classification.level} className="ml-2" />}
        <span className="ml-2 text-muted">
          {draft ? 'Submit it for review when you’re ready.' : `${CR_STATUS_LABEL[cr.status]}. This page shows the change once it is merged.`}
        </span>
      </span>
      <button type="button" className="ml-auto text-xs text-muted hover:text-fg" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
