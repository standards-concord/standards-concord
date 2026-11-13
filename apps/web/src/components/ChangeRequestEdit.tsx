import { useState } from 'react';
import { TERM_EDIT_FIELDS, type ChangeOp, type ChangeRequestDetail, type OntologyView, type TermEditField } from '@concord/shared';
import type { TermAnnotations } from '@concord/core/types';
import { describeOp, type Labeler } from '../lib/ontology';
import { dependentEdits, draftedNameError, isAddedOp, renameDraftedTerm } from '../lib/changeRequestEdits';
import { AnnotationFields, annotationValuesFrom, cleanAnnotationField, ListEditor } from './TermEditShared';
import { Disclosure } from './Disclosure';
import { Button, Dialog, Field, InlineError, Input, Textarea } from './ui';

export type RequestEdit = { cr: ChangeRequestDetail } & ({ kind: 'title' } | { kind: 'op' | 'remove'; index: number });
export type RequestPatch = { title?: string; description?: string; ops?: ChangeOp[] };
export function canEditOp(op: ChangeOp) {
  return isAddedOp(op) || ((op.op === 'updateAnnotations' || op.op === 'updateConcept') && Object.keys(op.set).length > 0) || op.op === 'deprecateTerm' || op.op === 'deprecateConcept';
}

function EditWarnings({ cr, independent }: { cr: ChangeRequestDetail; independent: boolean }) {
  return <>
    {['review', 'voting', 'approved'].includes(cr.status) && <p className="text-sm text-warn">Saving new edits starts a new review round: earlier approvals and yes votes stop counting. Objections and votes against stand.</p>}
    {independent && <p className="text-sm text-warn">After editing these, you can't also approve them.</p>}
  </>;
}

type FormProps = { cr: ChangeRequestDetail; pending: boolean; error: unknown; onSave: (patch: RequestPatch) => void; onCancel: () => void };
function TitleForm({ cr, pending, error, onSave, onCancel }: FormProps) {
  const [title, setTitle] = useState(cr.title);
  const [description, setDescription] = useState(cr.description);
  const patch: RequestPatch = { ...(title.trim() !== cr.title && { title: title.trim() }), ...(description.trim() !== cr.description && { description: description.trim() }) };
  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!pending && title.trim() && Object.keys(patch).length) onSave(patch); }}>
    <Field label="Title"><Input required value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
    <Field label="Why is this needed?"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    <InlineError error={error} />
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="primary" loading={pending} disabled={!title.trim() || !Object.keys(patch).length}>Save</Button>
    </div>
  </form>;
}

function OpForm({ cr, index, namespace, view, independent, label, pending, error, onSave, onCancel }: FormProps & { index: number; namespace: string; view: OntologyView; independent: boolean; label: Labeler }) {
  const op = cr.ops[index];
  const original: TermAnnotations = op.op === 'updateAnnotations' || op.op === 'updateConcept' ? op.set : isAddedOp(op) ? op : {};
  const [values, setValues] = useState(() => annotationValuesFrom(original));
  const [name, setName] = useState(isAddedOp(op) ? op.localName : '');
  const [reason, setReason] = useState('reason' in op ? op.reason : '');
  const [notation, setNotation] = useState(op.op === 'updateConcept' ? op.set.notation ?? '' : '');
  const [sources, setSources] = useState(original.source ?? []);
  const [mappings, setMappings] = useState(original.mappings ?? {});
  const addition = isAddedOp(op);
  const deprecation = op.op === 'deprecateTerm' || op.op === 'deprecateConcept';
  const fields = TERM_EDIT_FIELDS.filter((f) => addition ? op.op === 'addConceptScheme' ? !['comment', 'examples'].includes(f) : op.op === 'addConcept' ? f !== 'comment' : true : f in original);
  const initial = annotationValuesFrom(original);
  const changed = fields.filter((f) => JSON.stringify(cleanAnnotationField(f, values)) !== JSON.stringify(cleanAnnotationField(f, initial)));
  const nameError = addition ? draftedNameError(op, name.trim(), namespace, view, cr.ops, index) : undefined;
  const labelEmpty = fields.includes('label') && !values.label.trim();
  const needsDefinition = addition && op.op !== 'addIndividual' && !values.definition.trim();

  const annotations: TermAnnotations = { ...original };
  for (const field of changed) (annotations as Record<TermEditField, unknown>)[field] = cleanAnnotationField(field, values);
  if (op.op === 'updateAnnotations' && original.source && JSON.stringify(sources) !== JSON.stringify(original.source)) annotations.source = [...new Set(sources.map((s) => s.trim()).filter(Boolean))];
  if (op.op === 'updateAnnotations' && original.mappings && JSON.stringify(mappings) !== JSON.stringify(original.mappings)) annotations.mappings = Object.fromEntries(Object.entries(mappings).map(([predicate, targets]) => [predicate, [...new Set(targets.map((target) => target.trim()).filter(Boolean))]]));

  let edited: ChangeOp = op;
  if (addition) edited = { ...op, ...annotations } as ChangeOp;
  else if (op.op === 'updateAnnotations') edited = { ...op, set: annotations };
  else if (op.op === 'updateConcept') edited = { ...op, set: { ...op.set, ...annotations, ...('notation' in op.set && notation !== (op.set.notation ?? '') && { notation: notation.trim() }) } };
  else if (deprecation) edited = { ...op, reason: reason.trim() };
  let ops = cr.ops.map((o, i) => i === index ? edited : o);
  if (addition && name.trim() !== op.localName) ops = renameDraftedTerm(ops, index, name.trim(), namespace, view.prefixes);
  const canSave = !nameError && !labelEmpty && !needsDefinition && (!deprecation || !!reason.trim()) && JSON.stringify(ops) !== JSON.stringify(cr.ops);

  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!pending && canSave) onSave({ ops }); }}>
    {addition && <>
      <Field label="IRI local name" hint={<span className="break-all">{namespace + name.trim()}</span>}>
        <Input required value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} />
      </Field>
      {nameError && <p className="text-sm text-danger" role="alert">{nameError}</p>}
    </>}
    {deprecation ? <Field label="Reason"><Textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field> : <>
      <AnnotationFields values={values} onChange={setValues} fields={fields} changed={changed} labelEmpty={labelEmpty} />
      {needsDefinition && <p className="text-sm text-danger">A new term needs a definition.</p>}
      {op.op === 'updateConcept' && 'notation' in op.set && <Field label="Code"><Input value={notation} onChange={(e) => setNotation(e.target.value)} /></Field>}
      {op.op === 'updateAnnotations' && original.source && <ListEditor field="source" noun="source" items={sources} changed={JSON.stringify(sources) !== JSON.stringify(original.source)} onChange={setSources} />}
      {op.op === 'updateAnnotations' && original.mappings && <Disclosure title="Mappings" tone="muted">
        {Object.entries(mappings).map(([predicate, targets]) => <Field key={predicate} label={`Targets for ${label(predicate)}`} hint="One IRI per line."><Textarea rows={2} value={targets.join('\n')} onChange={(e) => setMappings({ ...mappings, [predicate]: e.target.value.split('\n') })} /></Field>)}
      </Disclosure>}
    </>}
    <p className="text-sm text-muted">To change the structure, ask the AI to revise or remove this edit and propose it again.</p>
    <InlineError error={error} />
    <EditWarnings cr={cr} independent={independent} />
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="primary" loading={pending} disabled={!canSave}>Save</Button>
    </div>
  </form>;
}

export function ChangeRequestEditDialog({ edit, namespace, view, label, userId, pending, error, onSave, onCancel }: { edit: RequestEdit; namespace: string; view?: OntologyView; label: Labeler; userId?: string; pending: boolean; error: unknown; onSave: (patch: RequestPatch) => void; onCancel: () => void }) {
  const { cr } = edit;
  const independent = userId !== cr.authorId && !cr.revisedBy?.includes(userId ?? '');
  const props = { cr, pending, error, onSave, onCancel };
  if (edit.kind === 'title') return <Dialog open onClose={onCancel} title="Edit title and reason"><TitleForm {...props} /></Dialog>;
  const d = describeOp(cr.ops[edit.index], label);
  if (edit.kind === 'remove') {
    const dependencies = dependentEdits(cr.ops, edit.index, namespace, view?.prefixes);
    return <Dialog open onClose={onCancel} title="Remove this edit">
      <div className="space-y-4">
        <p className="break-words text-sm">Remove “{d.verb}{d.title ? `: ${d.title}` : ''}”?</p>
        {!!dependencies.length && <div className="text-sm">
          <p>These edits depend on it and will fail validation until fixed:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{dependencies.map((i) => { const other = describeOp(cr.ops[i], label); return <li key={i}>{other.verb}: {other.title}</li>; })}</ul>
        </div>}
        <InlineError error={error} />
        <EditWarnings cr={cr} independent={independent} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
          <Button variant="danger" loading={pending} onClick={() => onSave({ ops: cr.ops.filter((_, i) => i !== edit.index) })}>Remove this edit</Button>
        </div>
      </div>
    </Dialog>;
  }
  return <Dialog open onClose={onCancel} title={`Edit “${d.title || d.verb}”`}>
    {view ? <OpForm {...props} index={edit.index} namespace={namespace} view={view} independent={independent} label={label} /> : <p className="text-sm text-muted">Loading the existing terms…</p>}
  </Dialog>;
}
