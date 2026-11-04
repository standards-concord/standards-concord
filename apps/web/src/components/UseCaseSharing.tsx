import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AnonymisedDraft, UseCaseDetail, UseCaseRef, UseCaseStatus, UseCaseVisibility } from '@concord/shared';
import { USE_CASE_STATUS_INFO, VISIBILITY_INFO, useCaseLabel } from '@concord/shared';
import { EyeOff, Globe, Lock, RefreshCw, ShieldCheck, Users, VenetianMask, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../lib/hooks';
import { Badge, Button, Field, InlineError, Input, Textarea, cx } from './ui';

/* ---------------------------------------------------------------- badges */

const STATUS_TONE: Record<UseCaseStatus, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'outline'> = {
  draft: 'outline',
  triage: 'warn',
  accepted: 'accent',
  'in-progress': 'accent',
  addressed: 'ok',
  closed: 'ok',
  deferred: 'neutral',
  'out-of-scope': 'neutral',
  archived: 'neutral',
};

export function UseCaseStatusBadge({ status, version }: { status: UseCaseStatus; version?: string }) {
  const info = USE_CASE_STATUS_INFO[status] ?? { label: status, description: '' };
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} title={info.description}>
      {status === 'closed' && version ? `Closed in ${version}` : info.label}
    </Badge>
  );
}

export const VISIBILITY_ICON: Record<UseCaseVisibility, LucideIcon> = { private: Lock, group: Users, public: Globe };

export function VisibilityBadge({ visibility, anonymous }: { visibility: UseCaseVisibility; anonymous?: boolean }) {
  if (anonymous)
    return (
      <Badge tone="outline" icon={VenetianMask} title="An anonymised, synthetic version of a use case described privately. Published with no name attached.">
        Anonymised
      </Badge>
    );
  const info = VISIBILITY_INFO[visibility];
  return (
    <Badge tone={visibility === 'private' ? 'warn' : 'outline'} icon={VISIBILITY_ICON[visibility]} title={info.description}>
      {info.label}
    </Badge>
  );
}

/** "UC-3 Title" link with its status. */
export function UseCaseRefLink({ ontologyId, r, showStatus = true }: { ontologyId: string; r: UseCaseRef; showStatus?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Link to={`/o/${ontologyId}/use-cases/${r.id}`} className="text-sm hover:text-accent">
        <span className="font-mono text-xs text-muted">{useCaseLabel(r)}</span> {r.title}
      </Link>
      {showStatus && <UseCaseStatusBadge status={r.status} />}
      {r.visibility !== 'public' && <VisibilityBadge visibility={r.visibility} />}
    </span>
  );
}

/* ---------------------------------------------------------------- sharing */

/** The author's choice of who sees the use case. */
export function VisibilityPicker({ uc, onChange }: { uc: UseCaseDetail; onChange: (u: UseCaseDetail) => void }) {
  const set = useAction(async (v: UseCaseVisibility) => onChange(await api.setUseCaseVisibility(uc.id, v)));
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Who can see this use case?</legend>
      <div className="space-y-1.5" role="radiogroup" aria-label="Who can see this use case?">
        {(['private', 'group', 'public'] as UseCaseVisibility[]).map((v) => {
          const Icon = VISIBILITY_ICON[v];
          const on = uc.visibility === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={set.pending || !uc.can.changeVisibility}
              onClick={() => !on && void set.run(v)}
              className={cx(
                'flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-not-allowed',
                on ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-surface-2',
              )}
            >
              <Icon className={cx('mt-0.5 size-4 shrink-0', on ? 'text-accent' : 'text-muted')} />
              <span>
                <span className="block text-sm font-medium">{VISIBILITY_INFO[v].label}</span>
                <span className="block text-xs text-muted">{VISIBILITY_INFO[v].description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <InlineError error={set.error} />
    </fieldset>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

type DraftForm = {
  name: string;
  goal: string;
  actors: string;
  description: string;
  requirements: string;
  scope: string;
  scenarios: string;
  steps: string;
  questions: { question: string; exampleAnswer: string }[];
  terms: { label: string; kind: AnonymisedDraft['terms'][number]['kind']; definition: string }[];
};

const toForm = (d: AnonymisedDraft): DraftForm => ({
  name: d.sections.name ?? '',
  goal: d.sections.goal ?? '',
  actors: d.sections.actors ?? '',
  description: d.sections.description ?? '',
  requirements: d.sections.requirements ?? '',
  scope: d.sections.scope ?? '',
  scenarios: (d.sections.usageScenarios ?? []).join('\n'),
  steps: (d.sections.basicFlow ?? []).map((f) => f.description).join('\n'),
  questions: d.competencyQuestions.map((q) => ({ question: q.question, exampleAnswer: q.exampleAnswer ?? '' })),
  terms: d.terms.map((t) => ({ label: t.label, kind: t.kind, definition: t.definition ?? '' })),
});

/** Exactly what will be published: the server cuts it to the same fields. */
const fromForm = (f: DraftForm): Partial<AnonymisedDraft> => ({
  sections: {
    name: f.name,
    goal: f.goal,
    actors: f.actors,
    description: f.description,
    requirements: f.requirements,
    scope: f.scope,
    usageScenarios: lines(f.scenarios),
    basicFlow: lines(f.steps).map((description, i) => ({ step: i + 1, description })),
  },
  competencyQuestions: f.questions.filter((q) => q.question.trim()).map((q) => ({ question: q.question, ...(q.exampleAnswer.trim() ? { exampleAnswer: q.exampleAnswer } : {}) })),
  terms: f.terms.filter((t) => t.label.trim()).map((t) => ({ label: t.label, kind: t.kind, ...(t.definition.trim() ? { definition: t.definition } : {}) })),
});

/**
 * The anonymised, synthetic version of a private use case, offered to its author.
 * It shows every field that would be published, all editable, plus what may still
 * identify someone. Nothing is published until the author has checked it and
 * presses "Publish anonymously".
 */
export function AnonymisedVersion({ uc, onChange, ontologyId }: { uc: UseCaseDetail; onChange: (u: UseCaseDetail) => void; ontologyId: string }) {
  const a = uc.anonymisation;
  const draft = a?.draft;
  const [form, setForm] = useState<DraftForm>();
  const [checked, setChecked] = useState(false);
  // A new draft (or redraft) resets the form and the author's check.
  useEffect(() => {
    if (draft) setForm(toForm(draft));
    setChecked(false);
  }, [draft]);
  const propose = useAction(async () => onChange(await api.proposeAnonymised(uc.id)));
  const decline = useAction(async () => onChange(await api.declineAnonymised(uc.id)));
  const [publishedId, setPublishedId] = useState<string>();
  const publish = useAction(async () => {
    if (!form) return;
    const r = await api.publishAnonymised(uc.id, fromForm(form));
    setPublishedId(r.published.id);
    onChange(r.original);
  });
  const pending = propose.pending || decline.pending || publish.pending;
  const set = (patch: Partial<DraftForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  if (!a || !draft || !form || a.status === 'withdrawn') {
    return (
      <div className="rounded-lg border border-dashed border-line-strong p-4 text-sm">
        {a?.status === 'withdrawn' && <p className="mb-2 font-medium">You withdrew the anonymised version. Only you can see it now.</p>}
        <p className="mb-3 text-muted">
          Want this to count without sharing it? Concord can draft an anonymised, synthetic version that keeps your requirements, to publish with no name attached. You read and edit every field before anything is published.
        </p>
        <Button icon={VenetianMask} loading={propose.pending} onClick={() => void propose.run()}>
          Draft an anonymised version
        </Button>
        <InlineError error={propose.error} />
      </div>
    );
  }

  if (a.status === 'published') {
    const id = publishedId ?? a.publishedId;
    return (
      <div className="rounded-lg border border-ok/40 bg-ok-soft/40 p-4 text-sm" data-testid="anonymised-published">
        <p className="flex items-center gap-1.5 font-medium">
          <ShieldCheck className="size-4 text-ok" /> Anonymised version published
        </p>
        <p className="mt-1 text-muted">
          “{draft.sections.name}” is public with no name attached, and goes through triage like any other use case. Your original stays private. You can withdraw the published version from its page.{' '}
          {id && (
            <Link className="text-accent hover:underline" to={`/o/${ontologyId}/use-cases/${id}`}>
              View the published version
            </Link>
          )}
        </p>
      </div>
    );
  }

  const warnings = draft.warnings ?? [];
  return (
    <section aria-label="Anonymised version" className="rounded-lg border border-accent/40 bg-accent-soft/20 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <VenetianMask className="size-4 text-accent" /> Anonymised version for publication
        </h3>
        {a.status === 'declined' ? <Badge tone="neutral">You kept it private</Badge> : <Badge tone="warn">Waiting for your OK</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted">
        This is everything that would be published, with <strong>no name attached</strong>, so the working group has a use case to justify adding these terms. The assistant tries to swap out names, places and anything identifying, but it can miss things, so read every field and edit what you need. Nothing is published unless you agree. Once a release includes it, the copy in that release on GitHub can’t be recalled; you can withdraw it from Concord at any time.
      </p>
      {!!warnings.length && (
        <div className="mb-3 rounded-md border border-warn/40 bg-warn-soft/40 p-3 text-xs" role="note" aria-label="Check before publishing">
          <p className="mb-1 font-medium">Check these before publishing: they may still identify someone.</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-3">
        <Field label="Title">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Goal">
          <Textarea rows={2} value={form.goal} onChange={(e) => set({ goal: e.target.value })} />
        </Field>
        <Field label="Actors">
          <Input value={form.actors} onChange={(e) => set({ actors: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Requirements">
          <Textarea rows={2} value={form.requirements} onChange={(e) => set({ requirements: e.target.value })} />
        </Field>
        <Field label="Scope">
          <Textarea rows={2} value={form.scope} onChange={(e) => set({ scope: e.target.value })} />
        </Field>
        <Field label="Scenarios" hint="One per line.">
          <Textarea rows={3} value={form.scenarios} onChange={(e) => set({ scenarios: e.target.value })} />
        </Field>
        <Field label="Main steps" hint="One per line.">
          <Textarea rows={3} value={form.steps} onChange={(e) => set({ steps: e.target.value })} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Competency questions and example answers</legend>
          {form.questions.map((q, i) => (
            <div key={i} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_auto]">
              <Input aria-label={`Question ${i + 1}`} value={q.question} onChange={(e) => set({ questions: form.questions.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} />
              <Input aria-label={`Example answer ${i + 1}`} placeholder="Example answer" value={q.exampleAnswer} onChange={(e) => set({ questions: form.questions.map((x, j) => (j === i ? { ...x, exampleAnswer: e.target.value } : x)) })} />
              <Button size="sm" variant="ghost" onClick={() => set({ questions: form.questions.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          {!form.questions.length && <p className="text-xs text-muted">No questions.</p>}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Terms</legend>
          {form.terms.map((t, i) => (
            <div key={i} className="grid gap-1.5 sm:grid-cols-[1fr_2fr_auto]">
              <Input aria-label={`Term ${i + 1}`} value={t.label} onChange={(e) => set({ terms: form.terms.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Input aria-label={`Definition ${i + 1}`} placeholder="Definition" value={t.definition} onChange={(e) => set({ terms: form.terms.map((x, j) => (j === i ? { ...x, definition: e.target.value } : x)) })} />
              <Button size="sm" variant="ghost" onClick={() => set({ terms: form.terms.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          {!form.terms.length && <p className="text-xs text-muted">No terms.</p>}
        </fieldset>
      </div>
      {!!draft.changes.length && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-accent">What the assistant changed ({draft.changes.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {draft.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>I have read every field above, and it doesn’t identify me or anyone else.</span>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" icon={Globe} loading={publish.pending} disabled={pending || !checked} onClick={() => void publish.run()}>
          Publish anonymously
        </Button>
        <Button variant="ghost" icon={RefreshCw} loading={propose.pending} disabled={pending} onClick={() => void propose.run()}>
          Redraft
        </Button>
        {a.status !== 'declined' && (
          <Button variant="ghost" icon={EyeOff} loading={decline.pending} disabled={pending} onClick={() => void decline.run()}>
            Keep it private
          </Button>
        )}
      </div>
      <InlineError error={publish.error || decline.error || propose.error} />
    </section>
  );
}
