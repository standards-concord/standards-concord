import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ChangeRequest, ChangeRequestDetail, TermEditField, TermEditInput, TermEditValues } from '@concord/shared';
import { TERM_EDIT_FIELDS } from '@concord/shared';
import type { TermView } from '@concord/core/types';
import { api, ApiError } from '../api';
import { ChangedMark, ListEditor, DefinitionMeaning, useEditRefresh } from './TermEditShared';
import { useAction, useAsync } from '../lib/hooks';
import { CR_STATUS_LABEL, LevelBadge } from './badges';
import { ruleSummary } from './PolicyRules';
import { useOntology } from '../pages/ontology/Layout';
import { Button, Field, InlineError, Input, Textarea } from './ui';

/**
 * Inline editor for a term's annotations (label, definition, comment, alternative
 * labels, examples, editorial note). Saving never edits the working draft: it
 * opens an editorial change request, which the ontology's governance policy
 * then classifies, validates and approves like any other change.
 *
 * Mount it with a key per ontology and term: its baseline (the values the edit
 * starts from) is fixed for the life of the form, and is only replaced when the
 * person explicitly loads the latest values after a conflict.
 */

type TextField = 'label' | 'definition' | 'comment' | 'editorialNote';
type ListField = 'altLabels' | 'examples';
type Values = Record<TextField, string> & Record<ListField, string[]>;
type Intent = NonNullable<TermEditInput['definitionIntent']>;

export const OPEN_STATUSES = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'];
const FIELD_LABEL: Record<TermEditField, string> = {
  label: 'Label',
  definition: 'Definition',
  comment: 'Comment',
  altLabels: 'Also known as',
  examples: 'Examples',
  editorialNote: 'Editorial note',
};

const isList = (f: TermEditField): f is ListField => f === 'altLabels' || f === 'examples';

function valuesFrom(t: TermView): Values {
  return {
    label: t.label ?? '',
    definition: t.definition ?? '',
    comment: t.comment ?? '',
    altLabels: [...(t.altLabels ?? [])],
    examples: [...(t.examples ?? [])],
    editorialNote: t.editorialNote ?? '',
  };
}

/** What gets sent: trimmed text, and lists without blanks or duplicates (entries keep their own line breaks). */
const clean = (f: TermEditField, v: Values) => (isList(f) ? [...new Set(v[f].map((x) => x.trim()).filter(Boolean))] : v[f].trim());

/** Same comparison as the server: lists are sets, since RDF gives them no order. */
function same(f: TermEditField, a: Values, b: Values) {
  const x = clean(f, a);
  const y = clean(f, b);
  return Array.isArray(x) && Array.isArray(y) ? x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]) : x === y;
}

/** Open change requests that already touch this term, so people don't propose the same edit twice. */
export function useOpenRequestsFor(ontologyId: string, iri: string, refreshKey?: string) {
  const all = useAsync(() => api.changeRequests(ontologyId), [ontologyId, refreshKey]);
  return useMemo(
    () => (all.data ?? []).filter((c) => OPEN_STATUSES.includes(c.status) && (JSON.stringify(c.ops).includes(JSON.stringify(iri)) || (c.origin.type === 'term-edit' && c.origin.termIri === iri) || (c.origin.type === 'code-list-edit' && c.origin.scheme === iri))),
    [all.data, iri],
  );
}

export function TermEditForm({ term, termLabel, onCancel, onProposed }: { term: TermView; termLabel: string; onCancel: () => void; onProposed: (cr: ChangeRequestDetail) => void }) {
  const { id, ontology } = useOntology();
  const [baseline, setBaseline] = useState<Values>(() => valuesFrom(term));
  const [form, setForm] = useState<Values>(() => valuesFrom(term));
  const [reason, setReason] = useState('');
  const [intent, setIntent] = useState<Intent>();
  /** After loading the latest values: what someone else changed, and which of those you had also edited (to resolve before saving). */
  const [refreshed, setRefreshed] = useState<{ theirs: { field: TermEditField; now: string | string[] }[]; unresolved: TermEditField[] }>();
  const others = useOpenRequestsFor(id, term.iri);
  const formRef = useRef<HTMLFormElement>(null);
  const intentName = useId();

  // A save that finishes after this editor has closed (e.g. the reader moved to
  // another term) must not touch whatever is on screen now.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const changed = TERM_EDIT_FIELDS.filter((f) => !same(f, form, baseline));
  const labelEmpty = !form.label.trim();
  const removesKeyText = (['label', 'definition'] as const).filter((f) => changed.includes(f) && baseline[f].trim() && !form[f].trim());
  const rewordsDefinition = changed.includes('definition') && !!baseline.definition.trim() && !!form.definition.trim();
  const needsIntent = rewordsDefinition && !intent;
  const patchRule = ontology.governance?.changes?.patch;
  const unresolved = refreshed?.unresolved ?? [];
  const canSave = changed.length > 0 && !labelEmpty && !needsIntent && unresolved.length === 0;

  const save = useAction(async (submit: boolean) => {
    const set: TermEditValues = {};
    const previous: TermEditValues = {};
    for (const f of changed) {
      (set as Record<string, unknown>)[f] = clean(f, form);
      (previous as Record<string, unknown>)[f] = baseline[f];
    }
    const cr = await api.proposeTermEdit(id, { termIri: term.iri, set, previous, reason: reason.trim() || undefined, definitionIntent: rewordsDefinition ? intent : undefined, submit });
    if (alive.current) onProposed(cr);
  });
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  const loadLatest = useEditRefresh({ form, baseline, fields: TERM_EDIT_FIELDS, same, fetchLatest: async () => valuesFrom(await api.term(id, term.iri)), alive,
    apply: (latest, next, theirs, unresolved) => { setRefreshed({ theirs: theirs.map((field) => ({ field, now: latest[field] })), unresolved }); setBaseline(latest); setForm(next); save.clearError(); },
  });
  const resolve = (f: TermEditField, keep: 'mine' | 'theirs') => {
    if (keep === 'theirs') setForm({ ...form, [f]: baseline[f] });
    setRefreshed((r) => r && { ...r, unresolved: r.unresolved.filter((x) => x !== f) });
  };
  const show = (v: string | string[]) => (Array.isArray(v) ? (v.length ? v.join('; ') : '(none)') : v || '(empty)');

  const text = (f: TextField, rows: number, hint?: string) => (
    <Field
      label={
        <>
          {FIELD_LABEL[f]}
          <ChangedMark on={changed.includes(f)} />
        </>
      }
      hint={hint}
    >
      {rows === 1 ? (
        <Input value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} aria-invalid={f === 'label' && labelEmpty} />
      ) : (
        <Textarea rows={rows} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
      )}
    </Field>
  );

  return (
    <form
      ref={formRef}
      className="space-y-4"
      aria-label={`Edit ${termLabel}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save.run(true);
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">Edit “{termLabel}”</h2>
        <p className="mt-1 text-sm text-muted">
          Your edit is proposed as a change request; the published ontology and the working draft stay as they are until it is approved and merged.
          {patchRule && <> Wording changes are patch changes here: {ruleSummary(patchRule, 'patch', ontology.governance)}.</>}
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

      {refreshed && (
        <div role="status" className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          {refreshed.theirs.length ? (
            <>
              <p className="font-medium">Loaded the latest values. Your edits are kept, and fields you didn’t touch now show the latest. Someone else changed:</p>
              <ul className="mt-1 list-disc space-y-1.5 pl-5">
                {refreshed.theirs.map(({ field, now }) => (
                  <li key={field}>
                    {FIELD_LABEL[field]}: <span className="text-muted">{show(now)}</span>
                    {refreshed.unresolved.includes(field) && (
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-warn">You changed this too.</span>
                        <Button type="button" size="sm" variant="secondary" onClick={() => resolve(field, 'theirs')}>
                          Use theirs
                        </Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => resolve(field, 'mine')}>
                          Keep mine
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>Loaded the latest values; nothing you are editing has changed.</p>
          )}
        </div>
      )}

      {text('label', 1)}
      {labelEmpty && <p className="-mt-2 text-xs text-danger">A term needs a label.</p>}
      {text('definition', 3, 'Strict OWL practice: genus and differentia, e.g. “A person who …”.')}
      {rewordsDefinition && <DefinitionMeaning name={intentName} intent={intent} onChange={setIntent} noun="term" />}
      {text('comment', 2)}
      <div className="grid gap-4 sm:grid-cols-2">
        <ListEditor field="altLabels" noun="alternative label" items={form.altLabels} changed={changed.includes('altLabels')} onChange={(v) => setForm({ ...form, altLabels: v })} />
        <ListEditor field="examples" noun="example" multiline items={form.examples} changed={changed.includes('examples')} onChange={(v) => setForm({ ...form, examples: v })} />
      </div>
      {text('editorialNote', 2)}

      <Field label="Why this change? (optional)" hint="Shown to reviewers with the change request.">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {(removesKeyText.length > 0 || (rewordsDefinition && intent === 'new-meaning')) && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm">
          {removesKeyText.length > 0 ? `Removing the ${removesKeyText.join(' and ')} of an existing term` : 'Changing what a term means'} is a <LevelBadge level="major" className="mx-0.5" /> change, so it needs the stricter sign-off
          {ontology.governance?.changes?.major && <>: {ruleSummary(ontology.governance.changes.major, 'major', ontology.governance)}</>}.
        </p>
      )}

      <InlineError error={save.error ?? loadLatest.error} />
      {conflict && (
        <Button type="button" size="sm" variant="secondary" loading={loadLatest.pending} onClick={() => void loadLatest.run()}>
          Load the latest values (keeps your text)
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <span className="mr-auto text-xs text-muted">
          {unresolved.length
            ? `Choose yours or theirs for: ${unresolved.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ')}`
            : needsIntent
              ? 'Say whether the new definition keeps the meaning'
              : changed.length ? `Changing: ${changed.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ')}` : 'No changes yet'}
        </span>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={save.pending}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" disabled={!canSave || save.pending} onClick={() => void save.run(false)}>
          Save as draft
        </Button>
        <Button type="submit" variant="primary" loading={save.pending} disabled={!canSave}>
          Propose change
        </Button>
      </div>
    </form>
  );
}

/** Shown on the term page after an edit is proposed, until the reader moves on. Takes focus so keyboard users land on the result. */
export function ProposedEditNotice({ cr, onDismiss }: { cr: ChangeRequestDetail; onDismiss: () => void }) {
  const draft = cr.status === 'draft';
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    linkRef.current?.focus();
  }, [cr.id]);
  return (
    <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-accent-soft px-3 py-2 text-sm">
      <span>
        {draft ? 'Saved as draft' : 'Proposed as'}{' '}
        <Link ref={linkRef} className="font-medium text-accent hover:underline" to={`/o/${cr.ontologyId}/changes/${cr.id}`}>
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
