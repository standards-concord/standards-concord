import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Plus, X } from 'lucide-react';
import type { ConceptView, ConceptSchemeView } from '@concord/core/types';
import { isValidLocalName } from '@concord/core/names';
import type { ChangeRequestDetail, CodeListEditOp, ConceptAnnotations, OntologyView } from '@concord/shared';
import { api, ApiError } from '../api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { codeListNamespace, derivedCodeName } from '../lib/codeLists';
import { allTerms } from '../lib/ontology';
import { compactIri } from '../lib/format';
import { useOntology } from '../pages/ontology/Layout';
import { Badge, Button, Card, Field, InlineError, Input, Select, Textarea, cx } from './ui';
import { Disclosure } from './Disclosure';
import { LevelBadge } from './badges';
import { ProposedEditNotice, useOpenRequestsFor } from './TermEdit';
import { ChangedMark, DefinitionMeaning, ListEditor, useEditRefresh } from './TermEditShared';


type Row = { key: number; label: string; definition: string; notation: string; localName?: string; parent: string; };
const blankRow = (key: number): Row => ({ key, label: '', definition: '', notation: '', parent: '' });
const local = (row: Row) => row.localName ?? derivedCodeName(row.label);
function localError(name: string, scheme: boolean, namespace: string, view: OntologyView, otherNames: string[]) {
  if (!isValidLocalName(name, scheme ? 'class' : 'individual')) return scheme ? 'Use UpperCamelCase letters and digits, starting with a capital letter.' : 'Use letters, digits and hyphens, starting with a letter or digit.';
  if (allTerms(view).some((t) => t.iri === namespace + name) || otherNames.includes(name)) return 'This IRI is already used. Choose another local name.';
}
function LocalName({ name, onChange, error, namespace }: { name: string; onChange: (s: string) => void; error?: string; namespace: string; }) {
  const { view } = useOntology();
  const [editing, setEditing] = useState(false);
  return <div className="space-y-1 text-xs text-muted">
    <p>IRI: {compactIri(namespace + name, view.data?.prefixes)} <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button></p>
    {editing && <Field label="IRI local name"><Input value={name} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} /></Field>}
    {error && <p className="text-danger">{error}</p>}
  </div>;
}
function NewCodeRows({ rows, setRows, codes, namespace, view, reserved = [] }: { rows: Row[]; setRows: (r: Row[]) => void; codes: ConceptView[]; namespace: string; view: OntologyView; reserved?: string[]; }) {
  const counter = useRef(1);
  return <div className="space-y-4">
    {rows.map((r, i) => {
      const set = (v: Partial<Row>) => setRows(rows.map((x) => x.key === r.key ? { ...x, ...v } : x));
      const error = localError(local(r), false, namespace, view, [...reserved, ...rows.filter((x) => x.key !== r.key).map(local)]);
      const duplicate = !!r.notation.trim() && [...codes.map((c) => c.notation), ...rows.filter((x) => x.key !== r.key).map((x) => x.notation.trim())].includes(r.notation.trim());
      return <fieldset key={r.key} className="space-y-3 border-t border-line pt-3">
        <legend className="sr-only">New code {i + 1}</legend>
        <div className="flex items-center justify-between gap-2">
          <span aria-hidden className="text-sm font-medium">New code {i + 1}</span>
          {rows.length > 1 && <Button type="button" size="sm" variant="ghost" icon={X} aria-label={`Remove new code ${i + 1}`} title={`Remove new code ${i + 1}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key).map((x) => x.parent === `new:${r.key}` ? { ...x, parent: '' } : x))} />}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <Field label="Label"><Input required value={r.label} onChange={(e) => set({ label: e.target.value })} /></Field>
          <Field label="Code (optional)"><Input value={r.notation} aria-invalid={duplicate} placeholder="e.g. GARD" onChange={(e) => set({ notation: e.target.value })} /></Field>
        </div>
        {duplicate && <p className="text-xs text-danger">This code is already used in the list.</p>}
        <Field label="Definition"><Textarea required rows={2} value={r.definition} onChange={(e) => set({ definition: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
          <Field label="Parent"><Select value={r.parent} onChange={(e) => set({ parent: e.target.value })}>
            <option value="">Top level</option>
            {codes.map((c) => <option key={c.iri} value={c.iri}>{c.label ?? c.iri}</option>)}
            {rows.slice(0, i).map((x) => <option key={x.key} value={`new:${x.key}`}>{x.label || `New code ${rows.indexOf(x) + 1}`}</option>)}
          </Select></Field>
          <div className="sm:pt-7"><LocalName name={local(r)} onChange={(localName) => set({ localName })} error={r.label ? error : undefined} namespace={namespace} /></div>
        </div>
      </fieldset>;
    })}
    <Button type="button" size="sm" variant="ghost" icon={Plus} disabled={rows.length >= 48} onClick={() => setRows([...rows, blankRow(counter.current++)])}>Add another code</Button>
  </div>;
}
function SaveButtons({ cancel, save, pending, disabled }: { cancel: () => void; save: () => void; pending: boolean; disabled: boolean; }) {
  return <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
    <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
    <Button type="button" variant="secondary" onClick={save} disabled={disabled || pending}>Save as draft</Button>
    <Button type="submit" variant="primary" loading={pending} disabled={disabled}>Propose change</Button>
  </div>;
}
function Reason({ value, onChange }: { value: string; onChange: (v: string) => void; }) {
  return <Field label="Why this change? (optional)" hint="Shown to reviewers with the change request."><Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}
function useFormLifetime() {
  const ref = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { alive.current = false; };
  }, []);
  return { ref, alive };
}

export function ProposeCodesForm({ scheme, onCancel, onProposed }: { scheme?: ConceptSchemeView; onCancel: () => void; onProposed: (c: ChangeRequestDetail) => void; }) {
  const { id, view } = useOntology();
  const v = view.data!;
  const namespace = codeListNamespace(v);
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [customName, setCustomName] = useState<string>();
  const schemeName = customName ?? derivedCodeName(name, true);
  const schemeIri = scheme?.iri ?? namespace + schemeName;
  const codes = (v.concepts ?? []).filter((c) => c.inScheme.includes(schemeIri));
  const [property, setProperty] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow(0)]);
  const [reason, setReason] = useState('');
  const { ref, alive } = useFormLifetime();
  const error = !scheme ? localError(schemeName, true, namespace, v, rows.map(local)) : undefined;
  const notations = [...codes.map((c) => c.notation), ...rows.map((r) => r.notation.trim())].filter(Boolean);
  const valid = (scheme || (name.trim() && definition.trim() && !error)) && rows.length > 0 && rows.every((r) => r.label.trim() && r.definition.trim() && !localError(local(r), false, namespace, v, [...(!scheme ? [schemeName] : []), ...rows.filter((x) => x.key !== r.key).map(local)])) && new Set(notations).size === notations.length;
  const save = useAction(async (submit: boolean) => {
    const ops: CodeListEditOp[] = [];
    if (!scheme) ops.push({ op: 'addConceptScheme', localName: schemeName, label: name.trim(), definition: definition.trim() });
    for (const r of rows) {
      const parent = r.parent.startsWith('new:') ? namespace + local(rows.find((x) => `new:${x.key}` === r.parent)!) : r.parent;
      ops.push({ op: 'addConcept', localName: local(r), label: r.label.trim(), definition: r.definition.trim(), notation: r.notation.trim() || undefined, scheme: schemeIri, broader: parent || undefined });
    }
    if (property) ops.push({ op: 'setCodeList', property, scheme: schemeIri });
    const cr = await api.proposeCodeListEdit(id, { ops, reason: reason.trim() || undefined, submit });
    if (alive.current) onProposed(cr);
  });
  return <form ref={ref} aria-label={scheme ? 'Propose codes' : 'New code list'} className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) void save.run(true); }}>
    {scheme ? <h3 className="text-base font-semibold">Propose codes for “{scheme.label}”</h3> : <h2 className="text-lg font-semibold">New code list</h2>}
    <p className="text-sm text-muted">Your edit is proposed as a change request; the published ontology and the working draft stay as they are until it is approved and merged.</p>
    {!scheme && <>
      <Field label="Name"><Input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Definition"><Textarea required rows={3} value={definition} onChange={(e) => setDefinition(e.target.value)} /></Field>
      <LocalName name={schemeName} onChange={setCustomName} error={name ? error : undefined} namespace={namespace} />
      <Field label="Use for property" hint="Data that already uses this property with other values would stop passing the checks, so this makes the change major."><Select value={property} onChange={(e) => setProperty(e.target.value)}><option value="">Choose later</option>{v.objectProperties.map((p) => <option key={p.iri} value={p.iri}>{p.label ?? p.iri}</option>)}</Select></Field>
    </>}
    <NewCodeRows rows={rows} setRows={setRows} codes={codes} namespace={namespace} view={v} reserved={!scheme ? [schemeName] : []} />
    {!rows.length && <p className="text-sm text-danger">Add at least one code.</p>}
    <Reason value={reason} onChange={setReason} />
    <InlineError error={save.error} />
    <SaveButtons cancel={onCancel} save={() => void save.run(false)} pending={save.pending} disabled={!valid} />
  </form>;
}

export function NewCodeListPanel({ onCancel }: { onCancel: () => void; }) {
  const { session } = useSession();
  const [proposed, setProposed] = useState<ChangeRequestDetail>();
  if (!session?.user) return <Card className="p-5"><p>Sign in to propose a code list.</p></Card>;
  return <Card className="p-5">{proposed ? <ProposedEditNotice cr={proposed} onDismiss={onCancel} /> : <ProposeCodesForm onCancel={onCancel} onProposed={setProposed} />}</Card>;
}

export function CodeListContents({ scheme, onSelect, onProposed, refreshKey }: { refreshKey?: string; scheme: ConceptSchemeView; onSelect: (iri: string) => void; onProposed: (c: ChangeRequestDetail) => void; }) {
  const { id, view, label } = useOntology();
  const { session } = useSession();
  const { alive } = useFormLifetime();
  const [adding, setAdding] = useState(false);
  const [using, setUsing] = useState(false);
  const [property, setProperty] = useState('');
  const [filter, setFilter] = useState('');
  const others = useOpenRequestsFor(id, scheme.iri, refreshKey);
  const codes = (view.data!.concepts ?? []).filter((c) => c.inScheme.includes(scheme.iri)).sort((a, b) => (a.notation ?? '').localeCompare(b.notation ?? '') || label(a.iri).localeCompare(label(b.iri)));
  const properties = view.data!.objectProperties.filter((p) => p.codeList === scheme.iri);
  const available = view.data!.objectProperties.filter((p) => p.codeList !== scheme.iri);
  const saveUse = useAction(async () => { const cr = await api.proposeCodeListEdit(id, { ops: [{ op: 'setCodeList', property, scheme: scheme.iri }], submit: true }); if (alive.current) { setUsing(false); onProposed(cr); } });
  const q = filter.trim().toLowerCase();
  const matches = new Set(codes.filter((c) => !q || `${c.label} ${c.notation ?? ''} ${c.definition ?? ''}`.toLowerCase().includes(q)).map((c) => c.iri));
  // Retain ancestors so filtering doesn't lose the hierarchy.
  const show = new Set(matches);
  const byIri = new Map(codes.map((c) => [c.iri, c]));
  const includeParents = (iri: string) => { for (const p of byIri.get(iri)?.broader ?? []) if (!show.has(p)) { show.add(p); includeParents(p); } };
  for (const iri of matches) includeParents(iri);
  const seen = new Set<string>();
  const tree = (items: ConceptView[], root = false) => !root && !items.some((c) => show.has(c.iri) && !seen.has(c.iri)) ? null : <ul aria-label={root ? `Codes in ${scheme.label ?? label(scheme.iri)}` : undefined} className={root ? 'space-y-2' : 'mt-2 ml-5 space-y-2 border-l border-line pl-3'}>
    {items.filter((c) => show.has(c.iri) && !seen.has(c.iri)).map((c) => {
      seen.add(c.iri);
      return <li key={c.iri}><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {c.notation && <span className="text-sm text-muted tabular-nums">{c.notation}</span>}
        <button type="button" className={cx('text-left text-sm text-accent hover:underline', c.deprecated && 'line-through')} onClick={() => onSelect(c.iri)}>{label(c.iri)}</button>
        {c.deprecated && <Badge tone="warn">Deprecated</Badge>}
        {c.definition && <span className="min-w-0 flex-1 truncate text-sm text-muted" title={c.definition}>{c.definition.split('\n')[0]}</span>}
      </div>{tree(codes.filter((x) => x.broader.includes(c.iri)))}</li>;
    })}
  </ul>;
  return <>
    {/* Same layout as the always-visible rows on other terms' panels. */}
    <dl className="border-t border-line">
      <div className="grid gap-1 py-2.5 sm:grid-cols-[160px_1fr] sm:items-baseline sm:gap-4">
        <dt className="text-xs font-medium text-muted">Values for</dt>
        <dd className="text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {properties.length ? properties.map((p, i) => <span key={p.iri}><button type="button" className="text-left text-accent hover:underline" onClick={() => onSelect(p.iri)}>{label(p.iri)}</button>{i < properties.length - 1 && <span className="text-muted">,</span>}</span>) : <span className="text-muted">No property uses this list yet.</span>}
            {session?.user && !using && available.length > 0 && <Button size="sm" variant="ghost" icon={Plus} onClick={() => setUsing(true)}>Use for a property</Button>}
          </span>
          {using && <form aria-label="Use for a property" className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (property) void saveUse.run(); }}>
            <Field label="Property" className="min-w-56 flex-1"><Select value={property} onChange={(e) => setProperty(e.target.value)}><option value="">Choose a property</option>{available.map((p) => <option key={p.iri} value={p.iri}>{label(p.iri)}</option>)}</Select></Field>
            <Button type="button" variant="ghost" onClick={() => setUsing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!property} loading={saveUse.pending}>Propose change</Button>
            <p className="w-full text-xs text-muted">Data that already uses this property with other values would stop passing the checks, so this is reviewed as a major change.</p>
            <InlineError error={saveUse.error} />
          </form>}
        </dd>
      </div>
    </dl>
    <Disclosure title="Codes" summary={codes.length} defaultOpen className="border-t border-line pt-3" heading={3}>
      {codes.length > 15 && <Field label="Filter codes"><Input value={filter} onChange={(e) => setFilter(e.target.value)} /></Field>}
      {tree(codes.filter((c) => !c.broader.some((p) => byIri.has(p))), true)}
      {!codes.length && <p className="text-sm text-muted">No codes yet.</p>}
      {q && !matches.size && <p className="text-sm text-muted">No codes match “{filter}”.</p>}
      {session?.user && !adding && <Button variant="ghost" size="sm" icon={Plus} className="mt-3" onClick={() => setAdding(true)}>Propose codes</Button>}
      {adding && <div className="mt-4"><ProposeCodesForm scheme={scheme} onCancel={() => setAdding(false)} onProposed={(cr) => { setAdding(false); onProposed(cr); }} /></div>}
    </Disclosure>
    {others.length > 0 && <div className="mt-4 text-sm"><p className="font-medium">Proposed changes waiting:</p><ul className="mt-1 space-y-1">{others.map((c) => <li key={c.id}><Link className="text-accent hover:underline" to={`/o/${id}/changes/${c.id}`}>#{c.number} {c.title}</Link></li>)}</ul></div>}
  </>;
}

type EditValues = { label: string; definition: string; notation: string; parent: string; altLabels: string[]; examples: string[]; editorialNote: string; };
const editValues = (t: ConceptView | ConceptSchemeView): EditValues => ({ label: t.label ?? '', definition: t.definition ?? '', notation: t.kind === 'concept' ? t.notation ?? '' : '', parent: t.kind === 'concept' ? t.broader[0] ?? '' : '', altLabels: t.altLabels ?? [], examples: t.examples ?? [], editorialNote: t.editorialNote ?? '' });
const clean = (v: string | string[]) => Array.isArray(v) ? [...new Set(v.map((s) => s.trim()).filter(Boolean))] : v.trim();
const same = (f: keyof EditValues, a: EditValues, b: EditValues) => { const x = clean(a[f]), y = clean(b[f]); return Array.isArray(x) && Array.isArray(y) ? JSON.stringify([...x].sort()) === JSON.stringify([...y].sort()) : x === y; };
const editLabels: Record<keyof EditValues, string> = { label: 'Label', definition: 'Definition', notation: 'Code', parent: 'Parent', altLabels: 'Also known as', examples: 'Examples', editorialNote: 'Editorial note' };
const annotationFields = ['label', 'definition', 'notation', 'altLabels', 'examples', 'editorialNote'] as const;
export function CodeEditForm({ term, onCancel, onProposed }: { term: ConceptView | ConceptSchemeView; onCancel: () => void; onProposed: (c: ChangeRequestDetail) => void; }) {
  const { id, view, label } = useOntology();
  const isCode = term.kind === 'concept';
  const fields: (keyof EditValues)[] = isCode ? [...annotationFields, 'parent'] : ['label', 'definition', 'altLabels', 'editorialNote'];
  const [baseline, setBaseline] = useState(() => editValues(term));
  const [form, setForm] = useState(() => editValues(term));
  const [intent, setIntent] = useState<'same-meaning' | 'new-meaning'>();
  const [reason, setReason] = useState('');
  const [deprecating, setDeprecating] = useState(false);
  const [deprecationReason, setDeprecationReason] = useState('');
  const [replacement, setReplacement] = useState('');
  const [refreshed, setRefreshed] = useState<{ theirs: (keyof EditValues)[]; unresolved: (keyof EditValues)[]; }>();
  const { ref, alive } = useFormLifetime();
  const changed = fields.filter((f) => !same(f, form, baseline));
  const rewords = changed.includes('definition') && !!baseline.definition && !!form.definition.trim();
  const valid = (changed.length > 0 || deprecating) && form.label.trim() && (!rewords || intent) && (!deprecating || deprecationReason.trim()) && !refreshed?.unresolved.length;
  const codes = isCode ? (view.data!.concepts ?? []).filter((c) => c.inScheme.some((s) => term.inScheme.includes(s))) : [];
  const excluded = new Set([term.iri]);
  const descendants = (iri: string) => { for (const c of codes) if (c.broader.includes(iri) && !excluded.has(c.iri)) { excluded.add(c.iri); descendants(c.iri); } };
  descendants(term.iri);
  const save = useAction(async (submit: boolean) => {
    const set: ConceptAnnotations = {}, previous: ConceptAnnotations = {};
    for (const f of annotationFields) if (changed.includes(f)) { Object.assign(set, { [f]: clean(form[f]) }); Object.assign(previous, { [f]: baseline[f] }); }
    const ops: CodeListEditOp[] = [];
    if (Object.keys(set).length) ops.push({ op: 'updateConcept', iri: term.iri, set, previous, definitionIntent: rewords ? intent : undefined });
    if (changed.includes('parent')) ops.push({ op: 'moveConcept', iri: term.iri, broader: form.parent || null, previous: { broader: baseline.parent || null } });
    if (deprecating) ops.push({ op: 'deprecateConcept', iri: term.iri, reason: deprecationReason.trim(), replacedBy: replacement || undefined });
    const cr = await api.proposeCodeListEdit(id, { ops, submit, reason: reason.trim() || undefined });
    if (alive.current) onProposed(cr);
  });
  const loadLatest = useEditRefresh({
    form, baseline, fields, same, alive, fetchLatest: async () => {
      const latest = await api.term(id, term.iri);
      if (latest.kind !== 'concept' && latest.kind !== 'conceptScheme') throw new Error('This code or code list is no longer available.');
      return editValues(latest);
    }, apply: (latest, next, theirs, unresolved) => { setBaseline(latest); setForm(next); setRefreshed({ theirs, unresolved }); save.clearError(); }
  });
  const text = (field: 'label' | 'definition' | 'notation' | 'editorialNote', rows = 1) => <Field label={<>{editLabels[field]}<ChangedMark on={changed.includes(field)} /></>}>
    {rows === 1 ? <Input value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} /> : <Textarea rows={rows} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />}
  </Field>;
  return <form ref={ref} aria-label={`Edit ${label(term.iri)}`} className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) void save.run(true); }}>
    <h2 className="text-lg font-semibold">Edit “{label(term.iri)}”</h2>
    <p className="text-sm text-muted">Your edit is proposed as a change request; the published ontology and the working draft stay as they are until it is approved and merged.</p>
    {refreshed && <div role="status" className="space-y-2 text-sm"><p>Loaded the latest values. Your edits are kept. {refreshed.theirs.length ? 'Someone else changed:' : 'Nothing you are editing has changed.'}</p>{refreshed.theirs.map((f) => <div key={f}>{editLabels[f]}: {Array.isArray(baseline[f]) ? baseline[f].join('; ') : baseline[f] || '(empty)'}{refreshed.unresolved.includes(f) && <div className="flex gap-2"><span>You changed this too.</span>{(['theirs', 'mine'] as const).map((choice) => <Button key={choice} type="button" variant="secondary" size="sm" onClick={() => { if (choice === 'theirs') setForm({ ...form, [f]: baseline[f] }); setRefreshed({ ...refreshed, unresolved: refreshed.unresolved.filter((x) => x !== f) }); }}>{choice === 'theirs' ? 'Use theirs' : 'Keep mine'}</Button>)}</div>}</div>)}</div>}
    {text('label')}{!form.label.trim() && <p className="text-xs text-danger">A {isCode ? 'code' : 'code list'} needs a label.</p>}
    {text('definition', 3)}
    {rewords && <DefinitionMeaning intent={intent} onChange={setIntent} noun={isCode ? 'code' : 'code list'} />}
    {isCode && <>
      {text('notation')}
      {changed.includes('notation') && baseline.notation && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm">Data that stored the old code will no longer match. This is a <LevelBadge level="major" /> change.</p>}
      <Field label={<>Parent<ChangedMark on={changed.includes('parent')} /></>}><Select value={form.parent} onChange={(e) => setForm({ ...form, parent: e.target.value })}><option value="">Top level</option>{codes.filter((c) => !excluded.has(c.iri)).map((c) => <option key={c.iri} value={c.iri}>{label(c.iri)}</option>)}</Select></Field>
      {changed.includes('parent') && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm">Moving this code changes its place in the list. This is a <LevelBadge level="major" /> change.</p>}
    </>}
    <ListEditor field="altLabels" noun="alternative label" items={form.altLabels} changed={changed.includes('altLabels')} onChange={(altLabels) => setForm({ ...form, altLabels })} />
    {isCode && <ListEditor field="examples" noun="example" multiline items={form.examples} changed={changed.includes('examples')} onChange={(examples) => setForm({ ...form, examples })} />}
    {text('editorialNote', 2)}
    {isCode && !term.deprecated && <Disclosure title="Deprecate this code" keepMounted>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deprecating} onChange={(e) => setDeprecating(e.target.checked)} />Deprecate this code with this change</label>
      {deprecating && <div className="mt-3 space-y-3"><Field label="Reason for deprecation"><Textarea required rows={2} value={deprecationReason} onChange={(e) => setDeprecationReason(e.target.value)} /></Field><Field label="Replacement code (optional)"><Select value={replacement} onChange={(e) => setReplacement(e.target.value)}><option value="">No replacement</option>{codes.filter((c) => c.iri !== term.iri).map((c) => <option key={c.iri} value={c.iri}>{label(c.iri)}</option>)}</Select></Field></div>}
    </Disclosure>}
    <Reason value={reason} onChange={setReason} />
    {((rewords && intent === 'new-meaning') || (changed.includes('definition') && baseline.definition && !form.definition.trim())) && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm">Changing what a {isCode ? 'code' : 'code list'} means is a <LevelBadge level="major" /> change, so it needs the stricter sign-off.</p>}
    <InlineError error={save.error ?? loadLatest.error} />
    {save.error instanceof ApiError && save.error.status === 409 && <Button type="button" variant="secondary" size="sm" loading={loadLatest.pending} onClick={() => void loadLatest.run()}>Load the latest values (keeps your text)</Button>}
    {rewords && !intent && <p className="text-xs text-muted">Say whether the new definition keeps the meaning</p>}
    <SaveButtons cancel={onCancel} save={() => void save.run(false)} pending={save.pending} disabled={!valid} />
  </form>;
}
