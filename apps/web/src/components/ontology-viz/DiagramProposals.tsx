import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { OntologyView } from '@concord/shared';
import { api } from '../../api';
import { accountToken, onAccountChange, stillCurrent } from '../../lib/session';
import type { Labeler } from '../../lib/ontology';
import { buildProposalPreview, changesToOps, deriveLocalName, describeChange, HOW_MANY, localNameError, PROPOSAL_DATATYPES, proposalTitle, superClassesFor, undoChange, wouldCreateCycle, type HowMany, type PendingChange, type ProposalPreview } from '../../lib/diagramProposals';
import { readProposalDraft, writeProposalDraft, type ProposalDraft } from '../../lib/diagramProposalStorage';
import { XSD } from '../../lib/ontologyModel';
import { Disclosure } from '../Disclosure';
import { Button, Field, InlineError, Input, Select, Textarea } from '../ui';

type Action = PendingChange['kind'];
const ACTIONS: Record<Action, string> = { class: 'Add class', attribute: 'Add attribute', relationship: 'Add relationship', superclass: 'Change superclass' };
interface FormValues {
  label: string;
  definition: string;
  localName: string;
  first: string;
  second: string;
  range: string;
  howMany: HowMany;
  mode: 'replace' | 'add';
}
export interface ProposalRenderState {
  toggle?: ReactNode;
  /** The proposal panel, while proposing: shown beside the diagram. */
  panel?: ReactNode;
  /** A one-line reminder of unsent proposals, while not proposing: shown above the diagram. */
  notice?: ReactNode;
  preview?: ProposalPreview;
  onPick?: (iri: string) => void;
}

/** Key this component by account and ontology so no form state crosses either boundary. */
export function DiagramProposals({ userId, ontologyId, namespace, view, label, selected, onSelect, children }: {
  userId?: string;
  ontologyId: string;
  namespace: string;
  view: OntologyView;
  label: Labeler;
  selected?: string;
  onSelect: (iri: string) => void;
  children: (state: ProposalRenderState) => ReactNode;
}) {
  const [draft, setDraft] = useState<ProposalDraft>(() => userId ? readProposalDraft(userId, ontologyId) : { items: [], title: '', description: '' });
  const [on, setOn] = useState(false);
  const [action, setAction] = useState<Action>();
  const [form, setForm] = useState<FormValues>({ label: '', definition: '', localName: '', first: '', second: '', range: XSD + 'string', howMany: 'any', mode: 'replace' });
  const [nameChanged, setNameChanged] = useState(false);
  const [formError, setFormError] = useState<unknown>();
  const [sendError, setSendError] = useState<unknown>();
  const [sending, setSending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const activeField = useRef<'first' | 'second' | undefined>(undefined);
  const token = useRef(accountToken());
  const alive = useRef(true);
  const navigate = useNavigate();
  const preview = useMemo(() => buildProposalPreview(view, draft.items, namespace), [view, draft.items, namespace]);
  const names: Labeler = (iri) => preview.model.classes.get(iri)?.label ?? preview.model.properties.get(iri)?.label ?? label(iri);
  const classes = [...preview.model.classes.values()].sort((a, b) => names(a.iri).localeCompare(names(b.iri)));
  const parents = preview.model.parents.get(form.first) ?? [];

  useEffect(() => {
    alive.current = true;
    const unsubscribe = onAccountChange(() => {
      alive.current = false;
      setDraft({ items: [], title: '', description: '' });
      setOn(false);
      setAction(undefined);
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (userId && stillCurrent(token.current, userId)) writeProposalDraft(userId, ontologyId, draft);
  }, [draft, userId, ontologyId]);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('input,select,textarea')?.focus();
  }, [action]);

  const updateItems = (items: PendingChange[]) => {
    setDraft((d) => ({ ...d, items, title: !d.title || d.title === proposalTitle(d.items, names) ? proposalTitle(items, names) : d.title }));
    setDiscarding(false);
    setSendError(undefined);
  };
  const closeForm = () => {
    const previous = action;
    setAction(undefined);
    setFormError(undefined);
    if (previous) buttons.current?.querySelector<HTMLButtonElement>(`[data-action="${previous}"]`)?.focus();
  };
  const openForm = (next: Action) => {
    setForm({ label: '', definition: '', localName: '', first: '', second: '', range: XSD + 'string', howMany: 'any', mode: 'replace', ...(selected && preview.model.classes.has(selected) ? { first: selected } : {}) });
    activeField.current = undefined;
    setNameChanged(false);
    setFormError(undefined);
    setAction(next);
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('input,select,textarea')?.focus());
  };
  const pick = (iri: string) => {
    if (action && preview.model.classes.has(iri)) {
      const field = activeField.current ?? (!form.first ? 'first' : action === 'relationship' || action === 'superclass' ? 'second' : 'first');
      setForm((f) => ({ ...f, [field]: iri }));
    } else if (!preview.terms.has(iri)) onSelect(iri);
  };
  const classField = (field: 'first' | 'second', title: string, optional = false) => (
    <Field label={title} hint="or click a class on the diagram">
      <Select aria-label={title} value={form[field]} onFocus={() => { activeField.current = field; }} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}>
        <option value="">{optional ? 'None' : 'Choose a class'}</option>
        {classes.map((c) => <option key={c.iri} value={c.iri}>{names(c.iri)}{preview.classes.has(c.iri) ? ' (proposed)' : ''}</option>)}
      </Select>
    </Field>
  );
  const add = () => {
    if (!action || sending) return;
    let item: PendingChange;
    const id = crypto.randomUUID();
    if (action === 'superclass') {
      if (!form.first || !form.second) {
        setFormError('Choose a class and a new superclass.');
        return;
      }
      if (wouldCreateCycle(preview.model, form.first, form.second)) {
        setFormError('A class cannot be its own superclass or have one of its subclasses as a superclass.');
        return;
      }
      item = { id, kind: action, classIri: form.first, parent: form.second, mode: form.mode, superClasses: superClassesFor(parents, form.second, form.mode) };
    } else {
      if (!form.label.trim() || !form.definition.trim()) {
        setFormError('Enter a label and a definition.');
        return;
      }
      const clash = localNameError(form.localName.trim(), namespace, view, draft.items);
      if (clash) {
        setFormError(clash);
        return;
      }
      if (action !== 'class' && (!form.first || action === 'relationship' && !form.second)) {
        setFormError('Choose the classes for this proposal.');
        return;
      }
      const term = { id, localName: form.localName.trim(), label: form.label.trim(), definition: form.definition.trim() };
      item = action === 'class' ? { ...term, kind: action, parent: form.first || undefined }
        : action === 'attribute' ? { ...term, kind: action, classIri: form.first, range: form.range, howMany: form.howMany }
        : { ...term, kind: action, from: form.first, to: form.second, howMany: form.howMany };
    }
    updateItems([...draft.items, item]);
    setAnnouncement('');
    closeForm();
  };
  const send = async () => {
    if (!userId || sending || !draft.items.length) return;
    if (!draft.title.trim()) {
      setSendError('Enter a title for the change request.');
      return;
    }
    setSending(true);
    setSendError(undefined);
    try {
      const cr = await api.createChangeRequest(ontologyId, { title: draft.title.trim(), description: draft.description.trim(), kind: 'feature', ops: changesToOps(draft.items, namespace), submit: true });
      if (!alive.current || !stillCurrent(token.current, userId)) return;
      writeProposalDraft(userId, ontologyId, { items: [], title: '', description: '' });
      setDraft({ items: [], title: '', description: '' });
      navigate(`/o/${ontologyId}/changes/${cr.id}`);
    } catch (error) {
      if (alive.current) setSendError(error);
    } finally {
      if (alive.current) setSending(false);
    }
  };
  if (!userId) return children({});

  const panel = on && (
    <section aria-labelledby="proposed-changes-title" className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <div>
        <h2 id="proposed-changes-title" className="font-semibold">Proposed changes</h2>
        <p className="mt-1 text-sm text-muted">Nothing changes until the change request is approved and merged.</p>
      </div>
      <div ref={buttons} className="flex flex-wrap gap-2">
        {(Object.entries(ACTIONS) as [Action, string][]).map(([kind, name]) => (
          <Button key={kind} data-action={kind} size="sm" variant="secondary" disabled={sending} onClick={() => openForm(kind)}>
            {name}
          </Button>
        ))}
      </div>
      {action && (
        <form
          ref={formRef}
          aria-label={ACTIONS[action]}
          className="space-y-4 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          {action !== 'class' && classField('first', action === 'relationship' ? 'From' : 'Class')}
          {(action === 'relationship' || action === 'superclass') && classField('second', action === 'relationship' ? 'To' : 'New superclass')}
          {action !== 'superclass' && (
            <>
              <Field label="Label">
                <Input
                  value={form.label}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    label: e.target.value,
                    localName: nameChanged ? f.localName : deriveLocalName(e.target.value, action === 'class' ? 'class' : 'property'),
                  }))}
                />
              </Field>
              <Field label="Definition">
                <Textarea value={form.definition} onChange={(e) => setForm((f) => ({ ...f, definition: e.target.value }))} />
              </Field>
              {action === 'class' && classField('first', 'Subclass of', true)}
              {action === 'attribute' && (
                <Field label="Type">
                  <Select value={form.range} onChange={(e) => setForm((f) => ({ ...f, range: e.target.value }))}>
                    {PROPOSAL_DATATYPES.map(([iri, name]) => <option key={iri} value={iri}>{name}</option>)}
                  </Select>
                </Field>
              )}
              {(action === 'attribute' || action === 'relationship') && (
                <Field label="How many">
                  <Select value={form.howMany} onChange={(e) => setForm((f) => ({ ...f, howMany: e.target.value as HowMany }))}>
                    {(Object.entries(HOW_MANY) as [HowMany, string][]).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                  </Select>
                </Field>
              )}
              <Disclosure title="Name in the IRI">
                <p className="mb-2 break-all text-sm text-muted">{namespace}</p>
                <Field label="Local name">
                  <Input value={form.localName} onChange={(e) => {
                    setNameChanged(true);
                    setForm((f) => ({ ...f, localName: e.target.value }));
                  }} />
                </Field>
              </Disclosure>
            </>
          )}
          {action === 'superclass' && parents.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Current superclasses</legend>
              {(['replace', 'add'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="superclass-mode" checked={form.mode === mode} onChange={() => setForm((f) => ({ ...f, mode }))} />
                  {mode === 'replace' ? 'Instead of' : 'As well as'} {parents.map(names).join(' and ')}
                </label>
              ))}
            </fieldset>
          )}
          <InlineError error={formError} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={sending}>Add to proposal</Button>
            <Button type="button" variant="secondary" onClick={closeForm}>Cancel</Button>
          </div>
        </form>
      )}
      <h3 className="border-t border-line pt-4 text-sm font-semibold">Your proposed changes</h3>
      <ol aria-label="Your proposed changes" className="list-decimal space-y-2 pl-5 text-sm">
        {draft.items.map((p) => {
          const sentence = describeChange(p, names);
          return (
            <li key={p.id}>
              <span>{sentence}</span>{' '}
              <Button
                size="sm"
                variant="ghost"
                disabled={sending}
                aria-label={`Undo: ${sentence}`}
                onClick={() => {
                  const result = undoChange(draft.items, p.id, namespace);
                  updateItems(result.items);
                  setAnnouncement(result.alsoRemoved ? `Also removed ${result.alsoRemoved} ${result.alsoRemoved === 1 ? 'change' : 'changes'} that used it` : 'Proposed change removed');
                  closeForm();
                }}
              >
                Undo
              </Button>
            </li>
          );
        })}
      </ol>
      {!draft.items.length && <p className="text-sm text-muted">No proposed changes yet.</p>}
      <p role="status" aria-live="polite" className="text-sm text-muted">{announcement}</p>
      <InlineError error={sendError} />
      {draft.items.length > 0 && (
        <div className="space-y-4">
          <Field label="Title">
            <Input value={draft.title} disabled={sending} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
          </Field>
          <Field label="Description (optional)">
            <Textarea value={draft.description} disabled={sending} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={sending} onClick={() => void send()}>{sending ? 'Opening change request…' : 'Open change request'}</Button>
            <Button variant="secondary" disabled={sending} onClick={() => setDiscarding(true)}>Discard all</Button>
          </div>
          {discarding && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">Discard {draft.items.length} proposed {draft.items.length === 1 ? 'change' : 'changes'}?</p>
              <Button variant="secondary" onClick={() => {
                setDraft({ items: [], title: '', description: '' });
                setDiscarding(false);
                closeForm();
                setAnnouncement('Proposed changes discarded');
              }}>Discard</Button>
              <Button variant="ghost" onClick={() => setDiscarding(false)}>Keep</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
  const notice = !on && draft.items.length > 0 && (
    <p className="text-sm">
      You have {draft.items.length} proposed {draft.items.length === 1 ? 'change' : 'changes'} not sent yet.{' '}
      <Button size="sm" variant="ghost" onClick={() => setOn(true)}>Review them</Button>
    </p>
  );

  return children({
    toggle: (
      <Button className="ml-auto" size="sm" variant={on ? 'primary' : 'secondary'} disabled={sending} aria-pressed={on} onClick={() => {
        setOn(!on);
        setAction(undefined);
      }}>Propose changes</Button>
    ),
    panel: panel || undefined,
    notice: notice || undefined,
    preview: on ? preview : undefined,
    onPick: on ? pick : undefined,
  });
}
