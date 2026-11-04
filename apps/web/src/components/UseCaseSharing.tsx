import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AnonymisedDraft, UseCaseDetail, UseCaseRef, UseCaseStatus, UseCaseVisibility } from '@concord/shared';
import { USE_CASE_STATUS_INFO, VISIBILITY_INFO } from '@concord/shared';
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
        <span className="font-mono text-xs text-muted">UC-{r.number}</span> {r.title}
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

/**
 * The anonymised, synthetic version of a private use case, offered to its author.
 * Nothing is published until the author presses "Publish anonymously".
 */
export function AnonymisedVersion({ uc, onChange, ontologyId }: { uc: UseCaseDetail; onChange: (u: UseCaseDetail) => void; ontologyId: string }) {
  const a = uc.anonymisation;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', goal: '', actors: '', description: '', scenarios: '', questions: '' });
  const draft = a?.draft;
  useEffect(() => {
    if (!draft) return;
    setForm({
      name: draft.sections.name ?? '',
      goal: draft.sections.goal ?? '',
      actors: draft.sections.actors ?? '',
      description: draft.sections.description ?? '',
      scenarios: (draft.sections.usageScenarios ?? []).join('\n'),
      questions: draft.competencyQuestions.map((q) => q.question).join('\n'),
    });
  }, [draft]);
  const propose = useAction(async () => onChange(await api.proposeAnonymised(uc.id)));
  const decline = useAction(async () => onChange(await api.declineAnonymised(uc.id)));
  const [publishedId, setPublishedId] = useState<string>();
  const publish = useAction(async () => {
    let edited: Partial<AnonymisedDraft> | undefined;
    if (editing && draft) {
      const qs = lines(form.questions);
      edited = {
        sections: { ...draft.sections, name: form.name, goal: form.goal, actors: form.actors, description: form.description, usageScenarios: lines(form.scenarios) },
        competencyQuestions: qs.map((q) => draft.competencyQuestions.find((x) => x.question === q) ?? { question: q }),
      };
    }
    const r = await api.publishAnonymised(uc.id, edited);
    setPublishedId(r.published.id);
    setEditing(false);
    onChange(r.original);
  });
  const pending = propose.pending || decline.pending || publish.pending;

  if (!a || !draft) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong p-4 text-sm">
        <p className="mb-3 text-muted">
          Want this to count without sharing it? Concord can write an anonymised, synthetic version that keeps your requirements but none of your details, to publish with no name attached.
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
          “{draft.sections.name}” is public with no name attached, and goes through triage like any other use case. Your original stays private.{' '}
          {id && (
            <Link className="text-accent hover:underline" to={`/o/${ontologyId}/use-cases/${id}`}>
              View the published version
            </Link>
          )}
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Anonymised version" className="rounded-lg border border-accent/40 bg-accent-soft/20 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <VenetianMask className="size-4 text-accent" /> Anonymised version for publication
        </h3>
        {a.status === 'declined' ? <Badge tone="neutral">You kept it private</Badge> : <Badge tone="warn">Waiting for your OK</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted">
        This synthetic version keeps your requirements and questions but none of your details. It would be published with <strong>no name attached</strong>, so the working group has a use case to justify adding these terms. Nothing is published unless you agree.
      </p>
      {editing ? (
        <div className="space-y-3">
          <Field label="Title">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Goal">
            <Textarea rows={2} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          </Field>
          <Field label="Actors">
            <Input value={form.actors} onChange={(e) => setForm({ ...form, actors: e.target.value })} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Scenarios" hint="One per line.">
            <Textarea rows={3} value={form.scenarios} onChange={(e) => setForm({ ...form, scenarios: e.target.value })} />
          </Field>
          <Field label="Competency questions" hint="One per line.">
            <Textarea rows={3} value={form.questions} onChange={(e) => setForm({ ...form, questions: e.target.value })} />
          </Field>
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs font-medium text-muted">Title</dt>
            <dd className="font-medium">{draft.sections.name || '—'}</dd>
          </div>
          {draft.sections.goal && (
            <div>
              <dt className="text-xs font-medium text-muted">Goal</dt>
              <dd>{draft.sections.goal}</dd>
            </div>
          )}
          {draft.sections.actors && (
            <div>
              <dt className="text-xs font-medium text-muted">Actors</dt>
              <dd>{draft.sections.actors}</dd>
            </div>
          )}
          {!!draft.sections.usageScenarios?.length && (
            <div>
              <dt className="text-xs font-medium text-muted">Scenarios</dt>
              <dd>
                <ul className="list-disc pl-5">
                  {draft.sections.usageScenarios.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {!!draft.competencyQuestions.length && (
            <div>
              <dt className="text-xs font-medium text-muted">Competency questions</dt>
              <dd>
                <ul className="list-disc pl-5">
                  {draft.competencyQuestions.map((q, i) => (
                    <li key={i}>{q.question}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}
      {!!draft.changes.length && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-accent">What was changed ({draft.changes.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {draft.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" icon={Globe} loading={publish.pending} disabled={pending} onClick={() => void publish.run()}>
          Publish anonymously
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => setEditing((x) => !x)}>
          {editing ? 'Stop editing' : 'Edit first'}
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
