import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useAction } from '../lib/hooks';
import { Button, Dialog, Field, InlineError, Input, Textarea } from './ui';

export function BugReportDialog({ open, onClose, ontologyId, termIri, termLabel }: { open: boolean; onClose: () => void; ontologyId: string; termIri?: string; termLabel?: string }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const submit = useAction(async () => {
    const cr = await api.reportBug(ontologyId, { title: title.trim() || `Problem with ${termLabel ?? 'a term'}`, description: description.trim(), termIri });
    onClose();
    nav(`/o/${ontologyId}/changes/${cr.id}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={termLabel ? `Report a problem with “${termLabel}”` : 'Report a bug'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submit.pending} disabled={!description.trim()} onClick={() => void submit.run()}>
            Submit report
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">Describe what’s wrong in your own words. Concord turns it into a change request, suggests a fix and classifies it (most bugs are patch-level).</p>
        <Field label="Short title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={termLabel ? `e.g. Definition of ${termLabel} is circular` : 'e.g. Missing range on hasStartDate'} />
        </Field>
        <Field label="What’s the problem?">
          <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you expect, and what did you find? An example helps." />
        </Field>
        <InlineError error={submit.error} />
      </div>
    </Dialog>
  );
}
