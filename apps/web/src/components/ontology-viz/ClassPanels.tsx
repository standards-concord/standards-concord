import { Fragment, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { OntologyView } from '@concord/shared';
import type { Labeler } from '../../lib/ontology';
import { cardText, isDatatype, type OntologyModel, type Slot } from '../../lib/ontologyModel';
import { Badge } from '../ui';
import { ClassDiagram, DEFAULT_DIAGRAM_OPTIONS, neighbourhood } from './ClassDiagram';

type Go = (iri: string) => void;

function Term({ iri, label, onSelect, model }: { iri: string; label: Labeler; onSelect: Go; model: OntologyModel }) {
  if (isDatatype(iri)) return <code className="font-mono text-[0.8rem] text-muted">{iri.replace(/^.*[#/]/, 'xsd:')}</code>;
  const known = model.classes.has(iri) || model.properties.has(iri);
  if (!known) return <span title={iri}>{label(iri)}</span>;
  return (
    <button type="button" className="text-accent hover:underline" onClick={() => onSelect(iri)}>
      {label(iri)}
    </button>
  );
}

/** Breadcrumbs from the top of the hierarchy, one line per inheritance path. */
export function HierarchyPath({ iri, model, label, onSelect }: { iri: string; model: OntologyModel; label: Labeler; onSelect: Go }) {
  const paths = model.paths(iri);
  return (
    <div className="space-y-0.5">
      {paths.map((p, i) => (
        <nav key={i} aria-label={paths.length > 1 ? `Hierarchy path ${i + 1}` : 'Hierarchy path'} className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <span>Thing</span>
          {p.map((x) => (
            <Fragment key={x}>
              <ChevronRight className="size-3 text-subtle" aria-hidden />
              {x === iri ? (
                <span aria-current="page" className="font-medium text-fg">
                  {label(x)}
                </span>
              ) : (
                <button type="button" className="hover:text-accent hover:underline" onClick={() => onSelect(x)}>
                  {label(x)}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
      ))}
    </div>
  );
}

function SlotRow({ s, label, onSelect, model }: { s: Slot; label: Labeler; onSelect: Go; model: OntologyModel }) {
  const card = cardText(s.min, s.max);
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className="py-2 pr-3 text-left font-medium">
        <Term iri={s.property.iri} label={label} onSelect={onSelect} model={model} />
        {s.property.kind === 'objectProperty' && <span className="sr-only"> (relationship)</span>}
      </th>
      <td className="py-2 pr-3">
        {s.rangeExpression ? (
          <code className="font-mono text-[0.8rem]">{s.rangeExpression}</code>
        ) : s.range.length ? (
          <span className="flex flex-wrap gap-x-1.5">
            {s.range.map((r, i) => (
              <span key={r}>
                <Term iri={r} label={label} onSelect={onSelect} model={model} />
                {i < s.range.length - 1 && <span className="text-muted"> or</span>}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">Anything</span>
        )}
        {s.closed && <span className="ml-1 text-xs text-muted">(only)</span>}
      </td>
      <td className="py-2 pr-3 font-mono text-[0.8rem] whitespace-nowrap" title={cardTitle(s)}>
        {card}
      </td>
      <td className="hidden py-2 text-muted md:table-cell">{s.property.definition}</td>
    </tr>
  );
}

function cardTitle(s: Slot) {
  const max = s.max === '*' ? 'any number' : `at most ${s.max}`;
  return s.min ? `at least ${s.min}, ${max}` : `optional, ${max}`;
}

/**
 * Everything an instance of the class can have, schema.org style: its own properties,
 * then those inherited from each ancestor. Types and cardinalities come from domains,
 * ranges, restrictions and functional characteristics.
 */
export function PropertyTable({ iri, model, label, onSelect }: { iri: string; model: OntologyModel; label: Labeler; onSelect: Go }) {
  const groups = model.allSlots(iri);
  const total = groups.reduce((n, g) => n + g.slots.length, 0);
  if (!total) return <p className="text-sm text-muted">No properties have this class (or its parents) as their domain yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={`Properties of ${label(iri)}`}>
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="pb-1.5 pr-3 font-medium">Property</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">Expected type</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">How many</th>
            <th scope="col" className="hidden pb-1.5 font-medium md:table-cell">Description</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.from}>
            {g.from !== iri && (
              <tr>
                <th colSpan={4} scope="rowgroup" className="bg-surface-2 px-2 py-1 text-left text-xs font-medium text-muted">
                  Inherited from <Term iri={g.from} label={label} onSelect={onSelect} model={model} />
                </th>
              </tr>
            )}
            {g.slots.length ? (
              g.slots.map((s) => <SlotRow key={s.property.iri} s={s} label={label} onSelect={onSelect} model={model} />)
            ) : (
              <tr className="border-t border-line">
                <td colSpan={4} className="py-2 text-muted">
                  None of its own; see the inherited properties below.
                </td>
              </tr>
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}

export function IncomingList({ iri, model, label, onSelect }: { iri: string; model: OntologyModel; label: Labeler; onSelect: Go }) {
  const rels = model.incoming(iri);
  if (!rels.length) return <span className="text-muted">No relationships point to this class.</span>;
  return (
    <ul className="space-y-1 text-sm">
      {rels.map((r, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
          <Term iri={r.from} label={label} onSelect={onSelect} model={model} />
          <span className="text-muted">→</span>
          <Term iri={r.property.iri} label={label} onSelect={onSelect} model={model} />
          <span className="font-mono text-xs text-muted">[{r.card}]</span>
          {r.via && <span className="text-xs text-muted">(points to its parent {label(r.via)})</span>}
        </li>
      ))}
    </ul>
  );
}

export function SubclassList({ iri, model, label, onSelect }: { iri: string; model: OntologyModel; label: Labeler; onSelect: Go }) {
  const kids = model.children.get(iri) ?? [];
  const all = model.descendants(iri).length;
  if (!kids.length) return <span className="text-muted">None</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {kids.map((k, i) => (
        <span key={k}>
          <Term iri={k} label={label} onSelect={onSelect} model={model} />
          {i < kids.length - 1 && <span className="text-muted">,</span>}
        </span>
      ))}
      {all > kids.length && <Badge>{all} including indirect</Badge>}
    </span>
  );
}

/** A small class diagram of the class and everything one link away. */
export function Neighbourhood({ iri, view, model, label, onSelect }: { iri: string; view: OntologyView; model: OntologyModel; label: Labeler; onSelect: Go }) {
  const scope = useMemo(() => {
    const near = neighbourhood(model, iri, 1, DEFAULT_DIAGRAM_OPTIONS);
    return near.size < 4 ? neighbourhood(model, iri, 2, DEFAULT_DIAGRAM_OPTIONS) : near;
  }, [model, iri]);
  return <ClassDiagram view={view} model={model} label={label} scope={scope} options={DEFAULT_DIAGRAM_OPTIONS} selected={iri} focus={iri} onSelect={onSelect} height={340} title={`Neighbourhood of ${label(iri)}`} />;
}
