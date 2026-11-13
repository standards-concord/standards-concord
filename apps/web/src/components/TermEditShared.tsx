import { useId, useRef, type ReactNode } from 'react';
import { TERM_EDIT_FIELDS, type TermEditField, type TermEditValues } from '@concord/shared';
import { Plus, X } from 'lucide-react';
import { useAction } from '../lib/hooks';
import { Button, Field, Input, Textarea, cx } from './ui';
type ListField = 'altLabels' | 'examples' | 'source';
const FIELD_LABEL = { altLabels: 'Also known as', examples: 'Examples', source: 'Sources' };

export type AnnotationValues = Record<'label' | 'definition' | 'comment' | 'editorialNote', string> & Record<'altLabels' | 'examples', string[]>;
export function annotationValuesFrom(t: TermEditValues): AnnotationValues {
  return { label: t.label ?? '', definition: t.definition ?? '', comment: t.comment ?? '', editorialNote: t.editorialNote ?? '', altLabels: [...(t.altLabels ?? [])], examples: [...(t.examples ?? [])] };
}
export const cleanAnnotationField = (f: TermEditField, v: AnnotationValues) => f === 'altLabels' || f === 'examples' ? [...new Set(v[f].map((x) => x.trim()).filter(Boolean))] : v[f].trim();

/** Shared wording fields for a term proposal and for correcting its drafted edits. */
export function AnnotationFields({ values, onChange, fields = TERM_EDIT_FIELDS, changed = [], labelEmpty, afterDefinition }: {
  values: AnnotationValues; onChange: (v: AnnotationValues) => void; fields?: readonly TermEditField[]; changed?: TermEditField[]; labelEmpty?: boolean; afterDefinition?: ReactNode;
}) {
  const text = (f: 'label' | 'definition' | 'comment' | 'editorialNote', label: string, rows: number, hint?: string) => fields.includes(f) && <Field label={<>{label}<ChangedMark on={changed.includes(f)} /></>} hint={hint}>
    {rows === 1 ? <Input value={values[f]} aria-invalid={f === 'label' && labelEmpty} onChange={(e) => onChange({ ...values, [f]: e.target.value })} /> : <Textarea rows={rows} value={values[f]} onChange={(e) => onChange({ ...values, [f]: e.target.value })} />}
  </Field>;
  return <>
    {text('label', 'Label', 1)}
    {fields.includes('label') && labelEmpty && <p className="-mt-2 text-xs text-danger">A term needs a label.</p>}
    {text('definition', 'Definition', 3, 'Strict OWL practice: genus and differentia, e.g. “A person who …”.')}
    {afterDefinition}
    {text('comment', 'Comment', 2)}
    {(fields.includes('altLabels') || fields.includes('examples')) && <div className="grid gap-4 sm:grid-cols-2">
      {fields.includes('altLabels') && <ListEditor field="altLabels" noun="alternative label" items={values.altLabels} changed={changed.includes('altLabels')} onChange={(v) => onChange({ ...values, altLabels: v })} />}
      {fields.includes('examples') && <ListEditor field="examples" noun="example" multiline items={values.examples} changed={changed.includes('examples')} onChange={(v) => onChange({ ...values, examples: v })} />}
    </div>}
    {text('editorialNote', 'Editorial note', 2)}
  </>;
}

export function ChangedMark({ on }: { on: boolean; }) {
  return on ? (
    <>
      {' '}
      <span className="ml-1 text-xs font-normal text-accent">changed</span>
    </>
  ) : null;
}

export function ListEditor({ field, items, onChange, changed, multiline, noun }: { field: ListField; items: string[]; onChange: (v: string[]) => void; changed: boolean; multiline?: boolean; noun: string; }) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusLast = () => requestAnimationFrame(() => [...(listRef.current?.querySelectorAll<HTMLElement>('input,textarea') ?? [])].at(-1)?.focus());
  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium">
        {FIELD_LABEL[field]}
        <ChangedMark on={changed} />
      </legend>
      <div ref={listRef} className="space-y-2">
        {items.map((v, i) => {
          const name = `${noun} ${i + 1}`;
          const set = (x: string) => onChange(items.map((y, j) => (j === i ? x : y)));
          return (
            <div key={i} className="flex items-start gap-1.5">
              {multiline ? <Textarea rows={2} aria-label={name} value={v} onChange={(e) => set(e.target.value)} className="min-h-14" /> : <Input aria-label={name} value={v} onChange={(e) => set(e.target.value)} />}
              <Button type="button" size="sm" variant="ghost" icon={X} aria-label={`Remove ${name}`} title={`Remove ${name}`} className="mt-0.5" onClick={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon={Plus}
        className={cx(items.length > 0 && 'mt-1')}
        onClick={() => {
          onChange([...items, '']);
          focusLast();
        }}
      >
        Add {items.length ? 'another ' : ''}
        {noun}
      </Button>
    </fieldset>
  );
}


/** Keep text typed during a refresh, and require an explicit choice for overlapping edits. */
export function useEditRefresh<V, F extends keyof V>({ form, baseline, fields, same, fetchLatest, alive, apply }: {
  form: V; baseline: V; fields: readonly F[]; same: (f: F, a: V, b: V) => boolean;
  fetchLatest: () => Promise<V>; alive: { current: boolean; };
  apply: (latest: V, next: V, theirs: F[], unresolved: F[]) => void;
}) {
  const now = useRef(form);
  now.current = form;
  return useAction(async () => {
    const latest: V = await fetchLatest();
    if (!alive.current) return;
    const current = now.current;
    const mine = fields.filter((f) => !same(f, current, baseline));
    const theirs = fields.filter((f) => !same(f, latest, baseline));
    const next: V = { ...latest };
    for (const f of mine) next[f] = current[f];
    apply(latest, next, theirs, theirs.filter((f) => mine.includes(f) && !same(f, current, latest)));
  });
}

export function DefinitionMeaning({ name, intent, onChange, noun }: { name?: string; intent?: 'same-meaning' | 'new-meaning'; onChange: (v: 'same-meaning' | 'new-meaning') => void; noun: string; }) {
  const id = useId();
  return <fieldset className="rounded-md border border-line px-3 py-2">
    <legend className="px-1 text-sm font-medium">Does the new definition keep the {noun}’s meaning?</legend>
    <label className="flex items-start gap-2 py-1 text-sm"><input type="radio" name={name ?? id} className="mt-1" checked={intent === 'same-meaning'} onChange={() => onChange('same-meaning')} /><span>Yes, it is clearer wording for the same thing<span className="block text-xs text-muted">Everything the old definition covered is still covered, and nothing else. Reviewed as a patch.</span></span></label>
    <label className="flex items-start gap-2 py-1 text-sm"><input type="radio" name={name ?? id} className="mt-1" checked={intent === 'new-meaning'} onChange={() => onChange('new-meaning')} /><span>No, it changes what the {noun} means<span className="block text-xs text-muted">Data already using the {noun} may no longer fit, so this is reviewed as a major change. A new {noun}, with this one deprecated, is often better.</span></span></label>
  </fieldset>;
}
