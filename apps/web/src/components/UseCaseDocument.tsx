import type { ReactNode } from 'react';
import type { UseCase, UseCaseSections } from '@concord/shared';
import { USE_CASE_SECTION_LABELS } from '@concord/shared';
import { CircleCheck, Circle } from 'lucide-react';
import { CqStatusChip } from './badges';
import { Badge, ProgressBar, cx } from './ui';
import { HighlightedCode } from './code/CodeView';
import { pct, titleCase } from '../lib/format';
import { Disclosure } from './Disclosure';

type Key = keyof UseCaseSections;

export const SECTION_GROUPS: { title: string; keys: Key[] }[] = [
  { title: 'Overview', keys: ['name', 'goal', 'description', 'requirements', 'scope', 'priority'] },
  { title: 'People and systems', keys: ['stakeholders', 'actors'] },
  { title: 'Conditions', keys: ['preconditions', 'postconditions', 'triggers', 'performance', 'assumptions'] },
  { title: 'Flows', keys: ['usageScenarios', 'basicFlow', 'alternateFlows'] },
  { title: 'Resources', keys: ['dataSources', 'externalOntologies', 'references'] },
  { title: 'Notes', keys: ['openIssues', 'notes'] },
];

export function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

type Flow = NonNullable<UseCaseSections['basicFlow']>;

function FlowTable({ steps }: { steps: Flow }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="w-10 py-1.5 pr-2 font-medium">#</th>
            <th className="py-1.5 pr-2 font-medium">Person</th>
            <th className="py-1.5 pr-2 font-medium">System</th>
            <th className="py-1.5 font-medium">What happens</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={i} className="border-b border-line/60 align-top last:border-0">
              <td className="py-1.5 pr-2 text-muted tabular-nums">{s.step}</td>
              <td className="py-1.5 pr-2">{s.actorPerson ?? '—'}</td>
              <td className="py-1.5 pr-2">{s.actorSystem ?? '—'}</td>
              <td className="py-1.5">{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimpleTable({ rows, cols }: { rows: Record<string, string | undefined>[]; cols: [string, string][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {cols.map(([, l]) => (
              <th key={l} className="py-1.5 pr-3 font-medium">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 align-top last:border-0">
              {cols.map(([k]) => (
                <td key={k} className="py-1.5 pr-3">
                  {r[k] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SectionValue({ k, s }: { k: Key; s: UseCaseSections }) {
  switch (k) {
    case 'basicFlow':
      return <FlowTable steps={s.basicFlow ?? []} />;
    case 'alternateFlows':
      return (
        <div className="space-y-3">
          {(s.alternateFlows ?? []).map((f, i) => (
            <div key={i}>
              <div className="mb-1 text-sm font-medium">{f.title}</div>
              <FlowTable steps={f.steps} />
            </div>
          ))}
        </div>
      );
    case 'dataSources':
      return (
        <SimpleTable
          rows={s.dataSources ?? []}
          cols={[
            ['name', 'Source'],
            ['type', 'Type'],
            ['description', 'Description'],
            ['owner', 'Owner'],
            ['access', 'Access'],
          ]}
        />
      );
    case 'externalOntologies':
      return (
        <SimpleTable
          rows={s.externalOntologies ?? []}
          cols={[
            ['name', 'Name'],
            ['language', 'Language'],
            ['description', 'Description'],
            ['source', 'Source'],
          ]}
        />
      );
    case 'usageScenarios':
    case 'references':
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {((s[k] as string[]) ?? []).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    default:
      return <p className="text-sm whitespace-pre-wrap">{s[k] as string}</p>;
  }
}

export function UseCaseDocument({
  uc,
  live,
  highlight = [],
  collapsible,
  showQueries = true,
}: {
  uc: UseCase;
  live?: boolean;
  highlight?: string[];
  /** Open the first group only; the rest show counts. */
  collapsible?: boolean;
  /** Show each question's SPARQL test. Off for people who only review: they need the question and whether it's answered. */
  showQueries?: boolean;
}) {
  const s = uc.sections ?? {};
  const firstShown = SECTION_GROUPS.findIndex((g) => g.keys.some((k) => isFilled(s[k])));
  return (
    <div className="space-y-6">
      {SECTION_GROUPS.map((g, gi) => {
        // While live, show what has been captured (and what is being asked about now) in full,
        // and list the sections still to cover as one compact line instead of empty boxes.
        const keys = g.keys.filter((k) => isFilled(s[k]) || (live && highlight.includes(k)));
        const todo = live ? g.keys.filter((k) => !keys.includes(k)) : [];
        if (!keys.length && !todo.length) return null;
        return (
          <GroupSection key={g.title} title={g.title} filled={g.keys.filter((k) => isFilled(s[k])).length} total={g.keys.length} collapsible={collapsible} defaultOpen={gi === firstShown}>
            <div className="space-y-3">
              {keys.map((k) => {
                const filled = isFilled(s[k]);
                return (
                  <div key={k} className={cx('rounded-lg transition-colors', live && 'border border-line p-3', highlight.includes(k) && 'border-accent bg-accent-soft/40')}>
                    <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                      {live && (filled ? <CircleCheck className="size-3.5 text-ok" /> : <Circle className="size-3.5 text-line-strong" />)}
                      {USE_CASE_SECTION_LABELS[k]}
                    </div>
                    {filled ? <SectionValue k={k} s={s} /> : <p className="text-xs text-subtle">{highlight.includes(k) ? 'The interviewer is asking about this now' : 'Not covered yet'}</p>}
                  </div>
                );
              })}
            </div>
            {todo.length > 0 && (
              <p className={cx('text-xs text-subtle', keys.length > 0 && 'mt-2')}>
                <span className="font-medium">Not covered yet:</span> {todo.map((k) => USE_CASE_SECTION_LABELS[k]).join(', ')}
              </p>
            )}
          </GroupSection>
        );
      })}
      <GroupSection title={`Competency questions (${uc.competencyQuestions.length})`} collapsible={collapsible} defaultOpen>
        <CompetencyQuestions uc={uc} highlight={highlight.includes('competencyQuestions')} compact={collapsible} bare showQueries={showQueries} />
      </GroupSection>
      <GroupSection title={`Terms mentioned (${uc.terms.length})`} collapsible={collapsible}>
        <ElicitedTerms uc={uc} highlight={highlight.includes('terms')} bare />
      </GroupSection>
    </div>
  );
}

export function CompetencyQuestions({
  uc,
  highlight,
  compact,
  bare,
  showQueries = true,
}: {
  uc: UseCase;
  highlight?: boolean;
  /** Question and status first; example, terms and test on request. */
  compact?: boolean;
  bare?: boolean;
  showQueries?: boolean;
}) {
  return (
    <section>
      {!bare && <h3 className="mb-2 text-sm font-semibold">Competency questions ({uc.competencyQuestions.length})</h3>}
      {uc.competencyQuestions.length ? (
        <ul className={cx('divide-y divide-line rounded-lg border border-line', highlight && 'border-accent')}>
          {uc.competencyQuestions.map((q) => (
            <li key={q.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium">{q.question}</p>
                <CqStatusChip status={q.status} />
              </div>
              {compact ? (
                hasDetail(q, showQueries) && (
                  <Disclosure
                    className="mt-1"
                    tone="muted"
                    title={
                      <span className="text-xs">
                        {showQueries && q.sparql ? 'Example answer, terms and test' : 'Example answer and terms'}
                        <span className="sr-only"> for “{q.question}”</span>
                      </span>
                    }
                  >
                    <CqDetail q={q} showTest={showQueries} />
                  </Disclosure>
                )
              ) : (
                <CqDetail q={q} showTest={showQueries ? undefined : false} />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-subtle">Questions the ontology must be able to answer will appear here.</p>
      )}
    </section>
  );
}

export function ElicitedTerms({ uc, highlight, bare }: { uc: UseCase; highlight?: boolean; bare?: boolean }) {
  return (
    <section>
      {!bare && <h3 className="mb-2 text-sm font-semibold">Terms mentioned ({uc.terms.length})</h3>}
      {uc.terms.length ? (
        <ul className={cx('grid gap-2 sm:grid-cols-2', highlight && 'rounded-lg ring-2 ring-accent/30')}>
          {uc.terms.map((t, i) => (
            <li key={i} className="rounded-lg border border-line p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t.label}</span>
                <span className="flex gap-1">
                  <Badge tone="outline">{titleCase(t.kind.replace(/([A-Z])/g, ' $1'))}</Badge>
                  {t.existingIri && <Badge tone="ok">exists</Badge>}
                </span>
              </div>
              {t.definition && <p className="mt-1 text-xs text-muted">{t.definition}</p>}
              {t.evidence?.[0] && <p className="mt-1 text-xs text-subtle italic">“{t.evidence[0]}”</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-subtle">Concepts you mention are captured here with your own words as evidence.</p>
      )}
    </section>
  );
}

export function CompletenessMeter({ value }: { value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">Completeness</span>
        <span className="tabular-nums text-muted">{pct(value)}</span>
      </div>
      <ProgressBar value={value} tone={value >= 0.7 ? 'ok' : 'accent'} />
    </div>
  );
}

function hasDetail(q: UseCase['competencyQuestions'][number], showQueries: boolean) {
  return !!(q.exampleAnswer || q.terms?.length || (showQueries && q.sparql));
}

/**
 * `showTest` true shows the SPARQL test directly, for when the detail is already behind a disclosure;
 * left out, the test is behind its own toggle; false leaves it out.
 */
function CqDetail({ q, showTest }: { q: UseCase['competencyQuestions'][number]; showTest?: boolean }) {
  return (
    <>
      {q.exampleAnswer && <p className="mt-1 text-xs text-muted">e.g. {q.exampleAnswer}</p>}
      {q.terms?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {q.terms.map((t) => (
            <Badge key={t} tone="outline">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}
      {q.sparql && showTest && (
        <div className="mt-1.5">
          <div className="text-xs font-medium text-muted">SPARQL test</div>
          <HighlightedCode code={q.sparql} language="sparql" className="mt-1" />
        </div>
      )}
      {q.sparql && showTest === undefined && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-accent">SPARQL test</summary>
          <HighlightedCode code={q.sparql} language="sparql" className="mt-1" />
        </details>
      )}
    </>
  );
}

/** A titled group of the use case document; collapsible on the read-only page. The heading stays a real heading either way. */
function GroupSection({
  title,
  filled,
  total,
  collapsible,
  defaultOpen,
  children,
}: {
  title: string;
  filled?: number;
  total?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  if (!collapsible)
    return (
      <section>
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        {children}
      </section>
    );
  return (
    <section>
      <Disclosure
        heading={3}
        title={<span className="text-sm font-semibold">{title}</span>}
        summary={filled !== undefined && total !== undefined ? `${filled} of ${total} filled` : undefined}
        defaultOpen={defaultOpen}
        keepMounted
      >
        {children}
      </Disclosure>
    </section>
  );
}

/** Sections filled out of the template's total, and the labels of those still empty, for progress summaries. */
export function sectionProgress(uc: UseCase) {
  const s = uc.sections ?? {};
  const keys = SECTION_GROUPS.flatMap((g) => g.keys);
  const missing = keys.filter((k) => !isFilled(s[k]));
  return { filled: keys.length - missing.length, total: keys.length, missing: missing.map((k) => USE_CASE_SECTION_LABELS[k]) };
}

export const sectionLabel = (k: string) => USE_CASE_SECTION_LABELS[k as Key] ?? (k === 'competencyQuestions' ? 'Competency questions' : k === 'terms' ? 'Terms' : k);
