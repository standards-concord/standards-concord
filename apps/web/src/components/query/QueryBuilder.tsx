import { useMemo } from 'react';
import { ArrowRight, CornerDownRight, Plus, Trash2 } from 'lucide-react';
import type { OntologyView } from '@concord/shared';
import type { Labeler } from '../../lib/ontology';
import { FILTER_LABELS, newStep, updateStep, allSteps, type BuilderModel, type FilterOp, type PathStep } from '../../lib/sparql-builder';
import { Button, Input, Select, Toggle } from '../ui';
import { GROUP_LABELS, propertyOptions, type PropertyOption } from './schema';

/**
 * Point-and-click query building: pick the kind of thing, then the
 * properties to show or filter on, following relationships to linked things.
 * The generated SPARQL is shown beside it and can be opened in the editor.
 */

function PropertySelect({
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  options: PropertyOption[];
  value?: string;
  onChange: (iri: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const groups = (['suggested', 'general', 'annotation', 'other'] as const).map((g) => [g, options.filter((o) => o.group === g)] as const).filter(([, os]) => os.length);
  return (
    <Select value={value ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={ariaLabel} className="w-auto! min-w-44!">
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {groups.map(([g, os]) => (
        <optgroup key={g} label={GROUP_LABELS[g]}>
          {os.map((o) => (
            <option key={o.iri} value={o.iri}>
              {o.label}
              {o.kind === 'object' ? ' →' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function StepRow({
  step,
  depth,
  view,
  label,
  classFor,
  onChange,
  variables,
}: {
  step: PathStep;
  depth: number;
  view: OntologyView;
  label: Labeler;
  classFor: (iri: string) => PropertyOption | undefined;
  onChange: (id: string, fn: (s: PathStep) => PathStep | null) => void;
  variables: Record<string, string>;
}) {
  const opt = classFor(step.property);
  const isObject = opt?.kind === 'object';
  const childOptions = useMemo(() => propertyOptions(view, opt?.range, label), [view, opt?.range, label]);
  const filtered = !!step.filter?.value.trim();
  return (
    <li data-testid="builder-step" data-property={step.property}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        {depth > 0 ? <CornerDownRight className="size-4 text-subtle" /> : <ArrowRight className="size-4 text-subtle" />}
        <span className="text-sm text-muted">{depth > 0 ? 'whose' : 'with'}</span>
        <span className="text-sm font-medium">{opt?.label ?? label(step.property)}</span>
        {isObject && opt?.range && <span className="text-xs text-muted">({label(opt.range)})</span>}
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-[var(--syn-variable)]">?{variables[step.id]}</code>
        <span className="mx-1 h-5 w-px bg-line" />
        <Select
          value={step.filter?.op ?? ''}
          onChange={(e) => onChange(step.id, (s) => ({ ...s, filter: e.target.value ? { op: e.target.value as FilterOp, value: s.filter?.value ?? '' } : undefined }))}
          aria-label="Filter"
          className="h-8 w-auto! text-xs"
        >
          <option value="">any value</option>
          {(Object.keys(FILTER_LABELS) as FilterOp[]).map((op) => (
            <option key={op} value={op}>
              {FILTER_LABELS[op]}
            </option>
          ))}
        </Select>
        {step.filter && (
          <Input
            value={step.filter.value}
            onChange={(e) => onChange(step.id, (s) => ({ ...s, filter: { op: s.filter!.op, value: e.target.value } }))}
            placeholder={isObject ? 'an IRI' : 'a value'}
            aria-label="Filter value"
            className="h-8 w-40! text-xs"
          />
        )}
        <div className="ml-auto flex items-center gap-3">
          <Toggle checked={step.show} onChange={(v) => onChange(step.id, (s) => ({ ...s, show: v }))} label={<span className="text-xs">Column</span>} />
          <span title={filtered ? 'A filtered property is always required' : undefined}>
            <Toggle checked={step.optional && !filtered} disabled={filtered} onChange={(v) => onChange(step.id, (s) => ({ ...s, optional: v }))} label={<span className="text-xs">Optional</span>} />
          </span>
          <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${opt?.label ?? 'property'}`} onClick={() => onChange(step.id, () => null)} />
        </div>
      </div>
      {(step.children.length > 0 || isObject) && (
        <ul className="mt-2 ml-6 space-y-2">
          {step.children.map((c) => (
            <StepRow key={c.id} step={c} depth={depth + 1} view={view} label={label} classFor={classFor} onChange={onChange} variables={variables} />
          ))}
          {isObject && (
            <li className="flex items-center gap-2">
              <CornerDownRight className="size-4 text-subtle" />
              <PropertySelect
                options={childOptions}
                onChange={(iri) => onChange(step.id, (s) => ({ ...s, children: [...s.children, newStep(iri)] }))}
                placeholder={`Add a property of the ${opt?.range ? label(opt.range) : 'linked thing'}…`}
                ariaLabel={`Add a property of ${opt?.label ?? 'the linked thing'}`}
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function QueryBuilder({
  view,
  label,
  model,
  onChange,
  variables,
  optionFor,
}: {
  view: OntologyView;
  label: Labeler;
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  variables: Record<string, string>;
  optionFor: (iri: string) => PropertyOption | undefined;
}) {
  const rootOptions = useMemo(() => propertyOptions(view, model.rootClass, label), [view, model.rootClass, label]);
  const classes = useMemo(() => [...view.classes].filter((c) => !c.deprecated).sort((a, b) => label(a.iri).localeCompare(label(b.iri))), [view, label]);
  const set = (patch: Partial<BuilderModel>) => onChange({ ...model, ...patch });
  const updateAt = (id: string, fn: (s: PathStep) => PathStep | null) => set({ steps: updateStep(model.steps, id, fn) });
  const orderable = allSteps(model.steps).filter((s) => s.show);

  return (
    <div className="space-y-3" data-testid="query-builder">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Find every</span>
        <Select
          value={model.rootClass}
          onChange={(e) => set({ rootClass: e.target.value, steps: [], orderBy: undefined })}
          aria-label="Class to find"
          className="w-auto! min-w-56!"
        >
          {classes.map((c) => (
            <option key={c.iri} value={c.iri}>
              {label(c.iri)}
            </option>
          ))}
        </Select>
        <Toggle checked={model.includeSubclasses} onChange={(v) => set({ includeSubclasses: v })} label={<span className="text-sm">including subclasses</span>} />
      </div>

      <ul className="space-y-2">
        {model.steps.map((s) => (
          <StepRow key={s.id} step={s} depth={0} view={view} label={label} classFor={optionFor} onChange={updateAt} variables={variables} />
        ))}
        <li className="flex items-center gap-2">
          <Plus className="size-4 text-subtle" />
          <PropertySelect
            options={rootOptions}
            onChange={(iri) => set({ steps: [...model.steps, newStep(iri)] })}
            placeholder="Add a property to show or filter on…"
            ariaLabel="Add a property"
          />
        </li>
      </ul>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-sm">
        <Toggle checked={model.countOnly} onChange={(v) => set({ countOnly: v })} label="Count only" />
        <Toggle checked={model.distinct} onChange={(v) => set({ distinct: v })} label="No duplicates" disabled={model.countOnly} />
        <label className="flex items-center gap-2">
          <span className="text-muted">Sort by</span>
          <Select value={model.orderBy ?? ''} onChange={(e) => set({ orderBy: e.target.value || undefined })} aria-label="Sort by" className="h-8 w-auto! text-xs" disabled={model.countOnly}>
            <option value="">no order</option>
            <option value="root">{label(model.rootClass)}</option>
            {orderable.map((s) => (
              <option key={s.id} value={s.id}>
                ?{variables[s.id]}
              </option>
            ))}
          </Select>
          {model.orderBy && <Toggle checked={model.descending} onChange={(v) => set({ descending: v })} label={<span className="text-xs">Descending</span>} />}
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">Limit</span>
          <Input
            type="number"
            min={1}
            value={model.limit ?? ''}
            onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })}
            aria-label="Limit"
            className="h-8 w-20! text-xs"
            disabled={model.countOnly}
          />
        </label>
      </div>
    </div>
  );
}
