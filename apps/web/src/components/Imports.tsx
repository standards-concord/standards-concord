import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ValidationReport } from '@concord/shared';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { Button, Dialog, Field, InlineError, Input, Select } from './ui';

const OTHER = '__other__';

/**
 * What this ontology builds on (its owl:imports), and a way for anyone signed in to propose importing
 * another: it opens a change request, which is checked with the imported ontology before anyone reviews it.
 */
export function ImportsSection({ ontologyId, ontologyIRI, report, canPropose }: { ontologyId: string; ontologyIRI: string; report?: ValidationReport; canPropose: boolean }) {
  const [open, setOpen] = useState(false);
  const check = report?.imports;
  const direct = check?.imports.filter((i) => i.via === ontologyIRI) ?? [];
  const elsewhere = check?.unresolved.filter((u) => u.via === ontologyIRI) ?? [];
  return (
    <section aria-labelledby="imports-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="imports-title" className="text-xl font-bold">
          Builds on
        </h2>
        {canPropose && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Import an ontology
          </Button>
        )}
      </div>
      {!report ? null : direct.length + elsewhere.length === 0 ? (
        <p className="mt-2 text-sm text-muted">This ontology doesn't import any others yet. Importing one lets you reuse its terms, and every change is then checked against it.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm" aria-label="Imported ontologies">
          {direct.map((i) => (
            <li key={i.iri}>
              {i.ontologyId ? (
                <Link to={`/o/${i.ontologyId}`} className="font-medium text-accent hover:underline">
                  {i.title}
                </Link>
              ) : (
                <span className="font-medium">{i.title}</span>
              )}{' '}
              <span className="text-muted">{i.version === 'draft' ? 'working draft' : `version ${i.version}`}</span>
            </li>
          ))}
          {elsewhere.map((u) => (
            <li key={u.iri}>
              <span className="break-all font-mono text-xs">{u.iri}</span> <span className="text-muted">(not on Concord, so not checked)</span>
            </li>
          ))}
        </ul>
      )}
      <FederationsLine ontologyId={ontologyId} />
      {open && <ImportDialog ontologyId={ontologyId} imported={[...direct.map((i) => i.iri), ...elsewhere.map((u) => u.iri)]} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ImportDialog({ ontologyId, imported, onClose }: { ontologyId: string; imported: string[]; onClose: () => void }) {
  const nav = useNavigate();
  const ontologies = useAsync(() => api.ontologies(), []);
  const choices = (ontologies.data ?? []).filter((o) => o.id !== ontologyId && !imported.includes(o.ontologyIRI));
  const [pick, setPick] = useState('');
  const [other, setOther] = useState('');
  const [why, setWhy] = useState('');
  const chosen = choices.find((o) => o.id === pick);
  const iri = pick === OTHER ? other.trim() : chosen?.ontologyIRI;
  const create = useAction(async () => {
    if (!iri) return;
    const title = `Import ${chosen?.title ?? iri}`;
    const cr = await api.createChangeRequest(ontologyId, { title, description: why.trim() || `Reuse the terms of ${chosen?.title ?? iri}.`, kind: 'feature', ops: [{ op: 'addImport', iri }] });
    nav(`/o/${ontologyId}/changes/${cr.id}?view=checks`);
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import an ontology"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.pending} disabled={!iri} onClick={() => void create.run()}>
            Propose the import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">This opens a change request. Concord checks this ontology together with the one you import, and the working group reviews it as usual.</p>
        <Field label="Ontology to import">
          <Select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
            <option value={OTHER}>Another ontology, by its IRI</option>
          </Select>
        </Field>
        {pick === OTHER && (
          <Field label="Ontology IRI" hint="Ontologies that aren't on Concord are listed but can't be checked.">
            <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="https://w3id.org/…" type="url" />
          </Field>
        )}
        <Field label="Why (optional)">
          <Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Reuse their definition of a person" />
        </Field>
        {ontologies.error ? <InlineError error={ontologies.error} /> : null}
        {create.error ? <InlineError error={create.error} /> : null}
      </div>
    </Dialog>
  );
}

/** The federations this ontology is in, if any (federations are an Advanced feature, so this shows only when there are some). */
function FederationsLine({ ontologyId }: { ontologyId: string }) {
  const feds = useAsync(() => api.ontologyFederations(ontologyId), [ontologyId]);
  if (!feds.data?.length) return null;
  return (
    <p className="mt-2 text-sm text-muted" data-testid="federations-line">
      Used together with other ontologies in{' '}
      {feds.data.map((f, i) => (
        <span key={f.id}>
          {i > 0 && ', '}
          <Link to={`/f/${f.slug}`} className="text-accent hover:underline">
            {f.title}
          </Link>
          {f.committed && ' (committed)'}
        </span>
      ))}
      .
    </p>
  );
}
