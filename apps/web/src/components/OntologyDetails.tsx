import { useState, type ReactNode } from 'react';
import type { OntologySummary } from '@concord/shared';
import { api } from '../api';
import { useAction } from '../lib/hooks';
import { Button, Dialog, Field, InlineError, Input, Textarea } from './ui';

type Details = { title: string; description: string; domain: string };

/** Listing fields shared by creation and editing; the prefix belongs only to creation. */
export function OntologyDetailsFields({ value, onChange, afterTitle, creating }: { value: Details; onChange: (field: keyof Details, value: string) => void; afterTitle?: ReactNode; /** A new ontology: the description goes into the ontology file, so it is required. */ creating?: boolean }) {
  const required = <span className="text-muted">(required)</span>;
  return (
    <>
      <Field label={<>Title {required}</>}>
        <Input required aria-required="true" value={value.title} maxLength={200} onChange={(e) => onChange('title', e.target.value)} placeholder="e.g. Volunteering Data Standard" />
      </Field>
      {afterTitle}
      <Field label={creating ? <>Description {required}</> : 'Description'} hint={creating ? 'Say what the standard is for and who will use it. A standard needs a description to pass its checks.' : undefined}>
        <Textarea required={creating} aria-required={creating ? 'true' : undefined} value={value.description} onChange={(e) => onChange('description', e.target.value)} placeholder="What is this ontology for, and who will use it?" />
      </Field>
      <Field label="Subject area" hint="Helps the AI interviewer ask relevant questions.">
        <Input value={value.domain} onChange={(e) => onChange('domain', e.target.value)} placeholder="e.g. charity volunteering, energy networks" />
      </Field>
    </>
  );
}

export function EditOntologyDetailsDialog({ ontology, onClose, onSaved }: { ontology: OntologySummary; onClose: () => void; onSaved: (details: OntologySummary) => Promise<void> }) {
  const [form, setForm] = useState<Details>({ title: ontology.title, description: ontology.description, domain: ontology.domain ?? '' });
  const changed = (Object.keys(form) as (keyof Details)[]).some((key) => form[key].trim() !== (ontology[key] ?? ''));
  const save = useAction(async () => {
    const details = await api.updateOntology(ontology.id, form);
    await onSaved(details);
    onClose();
  });
  return (
    <Dialog open onClose={onClose} title="Edit details" footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.pending} disabled={!changed || !form.title.trim()} onClick={() => void save.run()}>Save details</Button>
      </>
    }>
      <div className="space-y-4">
        <p className="text-sm text-muted">This changes how the standard is listed in Concord. The title and description inside the ontology file change through a change request.</p>
        <OntologyDetailsFields value={form} onChange={(field, value) => setForm((f) => ({ ...f, [field]: value }))} />
        <InlineError error={save.error} />
      </div>
    </Dialog>
  );
}
