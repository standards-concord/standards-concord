import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ActivityItem, Role, User } from '@concord/shared';
import { ArrowLeft, ArrowRight, Check, CircleCheck, Compass, FastForward, MessageSquareHeart, Play, RotateCcw, X } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useDemoOntology } from '../lib/ontologies';
import { STEPS, TESTER_ROLES, tasksFor, testerRoleFor, useWalkthrough, showWalkthroughDock } from '../lib/walkthrough';
import { formatDate, roleLabel } from '../lib/format';
import { ActivityList } from './ActivityFeed';
import { Avatar, Badge, Button, ErrorCard, InlineError, Loading, cx, LinkButton } from './ui';
import { Disclosure, Popover } from './Disclosure';
import { changeIsFor } from '@concord/shared';
import { changeLink, useTester } from '../lib/tester';
import { ChangeList } from './TesterStatus';

export function Stepper({ current, onPick, compact }: { current: number; onPick?: (i: number) => void; compact?: boolean }) {
  return (
    <ol className={cx('flex items-center', compact ? 'gap-1' : 'gap-2')}>
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => onPick?.(i)}
            className={cx(
              'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
              i < current ? 'border-accent bg-accent text-accent-fg' : i === current ? 'border-accent text-accent' : 'border-line-strong text-muted',
            )}
            aria-current={i === current ? 'step' : undefined}
            title={s.title}
          >
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </button>
          {!compact && <span className={cx('hidden truncate text-xs md:inline', i === current ? 'font-medium' : 'text-muted')}>{s.title}</span>}
          {i < STEPS.length - 1 && <span className={cx('h-px flex-1', i < current ? 'bg-accent' : 'bg-line')} />}
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------------- steps */

function WelcomeStep() {
  const w = useWalkthrough();
  return (
    <div className="space-y-3 text-sm">
      <p>
        <strong>Concord</strong> is a prototype from the Open Data Institute for designing strict OWL ontologies together, with AI help, and governing them without needing meetings.
      </p>
      <p className="text-muted">It takes about 5 minutes. Everything here is a sandbox: other participants are simulated, and you can fast-forward time.</p>
      <Button variant="primary" icon={ArrowRight} onClick={w.next}>
        Let’s start
      </Button>
      <Disclosure tone="muted" title="What can I try?">
        <ul className="space-y-1.5 text-muted">
          <li>• Describe how you use data to an AI interviewer (typed or spoken), or let a bot co-facilitate your Google Meet.</li>
          <li>• Proposed changes are classified as patch / minor / major, validated by a reasoner, quality-checked and FAIR-scored.</li>
          <li>• Review and voting follow a governance policy you choose, then versions are released and published.</li>
          <li>• Coding agents connect over MCP to read the ontology and report gaps.</li>
        </ul>
      </Disclosure>
    </div>
  );
}

function RoleStep({ compact }: { compact?: boolean }) {
  const w = useWalkthrough();
  const tester = useTester();
  const { session, setSession } = useSession();
  const personas = useAsync(() => api.personas(), []);
  const [chosen, setChosen] = useState<string>();
  const login = useAction(async (body: { userId?: string; name?: string; role?: string }) => {
    const s = await api.demoLogin(body as { userId?: string });
    setSession(s);
    w.next();
  });
  if (personas.error) return <ErrorCard error={personas.error} onRetry={personas.reload} />;
  if (!personas.data) return <Loading label="Loading personas…" />;

  // Before sign-in the demo's member list isn't readable, so fall back to the roles the persona list carries.
  const rolesOf = (u: User & { roles?: Role[] }) => w.demo?.members?.find((m) => m.userId === u.id)?.roles ?? u.roles;
  const grouped = TESTER_ROLES.map((r) => ({ role: r, people: personas.data!.filter((p) => testerRoleFor(p, rolesOf(p)).key === r.key) }));
  // Start with the role of whoever is signed in, if they're one of the personas.
  const currentKey = grouped.find((g) => g.people.some((p) => p.id === session?.user?.id))?.role.key;
  const open = chosen ?? currentKey;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">First choose a role, then the person you’ll be. The others will act around you, and you can switch at any time.</p>
      {tester.since && tester.changes.length > 0 && (
        <p className="text-xs text-muted">Roles marked “new” have changes made for them since {tester.since}, the version you last tested.</p>
      )}
      <InlineError error={login.error} />
      <div className={cx('grid gap-3', !compact && 'sm:grid-cols-2')}>
        {grouped.map(({ role, people }) => {
          const expanded = open === role.key;
          return (
            <section key={role.key} aria-label={role.title} className={cx('rounded-xl border bg-surface p-4', expanded ? 'border-accent sm:col-span-2' : 'border-line')}>
              <button type="button" aria-expanded={expanded} onClick={() => setChosen(expanded ? '' : role.key)} className="w-full text-left">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {role.title}
                    {tester.since && tester.newForRole(role.key).length > 0 && (
                      <Badge tone="accent" title={tester.newForRole(role.key).map((c) => c.title).join('; ')}>
                        {tester.newForRole(role.key).length} new since {tester.since}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs font-medium text-accent">{expanded ? 'Hide people' : people.length ? `Choose (${people.length})` : 'Choose'}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">{role.blurb}</p>
              </button>
              {expanded && (
                <div className={cx('mt-3 grid gap-2', !compact && 'sm:grid-cols-2')}>
                  {people.map((p) => {
                    const current = session?.user?.id === p.id;
                    return (
                      <button
                        key={p.id}
                        disabled={login.pending}
                        onClick={() => void login.run({ userId: p.id })}
                        title={p.persona}
                        className={cx('flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors', current ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/60 hover:bg-surface-2')}
                      >
                        <Avatar name={p.name} src={p.avatarUrl} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {p.name}
                            {current && <CircleCheck className="size-3.5 text-accent" />}
                          </span>
                          {p.organisation && <span className="block text-xs text-muted">{p.organisation}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {!people.length && (
                    <Button size="sm" variant="ghost" disabled={login.pending} onClick={() => void login.run({ name: 'Alpha tester', role: role.roles[0] })}>
                      Join as a new {role.title.toLowerCase()}
                    </Button>
                  )}
                  {people.length > 0 && (
                    <Disclosure className={cx(!compact && 'sm:col-span-2')} tone="muted" title={<span className="text-xs">About these people and their permissions</span>}>
                      <ul className="space-y-2 text-xs">
                        {people.map((p) => (
                          <li key={p.id}>
                            <span className="font-medium">{p.name}</span>
                            {rolesOf(p)?.length ? <span className="text-muted"> · {rolesOf(p)!.map(roleLabel).join(', ')}</span> : null}
                            {p.persona && <span className="block text-subtle">{p.persona}</span>}
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TourStep({ compact }: { compact?: boolean }) {
  const w = useWalkthrough();
  const tester = useTester();
  const demo = useDemoOntology();
  const { session } = useSession();
  if (!session?.user)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted">Pick a role first so we can tailor what to try.</p>
        <Button size="sm" icon={ArrowLeft} onClick={() => w.setStep(1)}>
          Pick a role
        </Button>
      </div>
    );
  if (!demo) return <p className="text-sm text-muted">Looking for the demo ontology… (if this persists, create one from the hub).</p>;
  // Returning testers: what changed for their role since they last tested comes first.
  const whatsNew = tester.since ? tester.forRole.filter((c) => c.type !== 'fix' && changeIsFor(c, tester.roleKey) && changeLink(c.to, demo.id)).slice(0, 3) : [];
  const newTasks = new Set(tester.changes.filter((c) => changeIsFor(c, tester.roleKey)).flatMap((c) => c.tasks ?? []));
  const roleTasks = tasksFor(w.myRoles, demo.id);
  const tasks = [...roleTasks.filter((t) => newTasks.has(t.id)), ...roleTasks.filter((t) => !newTasks.has(t.id))];
  const doneCount = tasks.filter((t) => w.done[t.id]).length;
  const nextTask = tasks.find((t) => !w.done[t.id]);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        The demo ontology is <Link className="font-medium text-accent hover:underline" to={`/o/${demo.id}`}>{demo.title}</Link>. As{' '}
        {w.myRoles.length ? <strong>{w.myRoles.map(roleLabel).join(', ')}</strong> : 'a participant'}, here’s something to try.
      </p>
      {whatsNew.length > 0 && (
        <section aria-label={`New since ${tester.since}`} className="space-y-2">
          <h3 className="text-sm font-medium text-muted">New since you last tested ({tester.since})</h3>
          <ChangeList changes={whatsNew} demoId={demo.id} compact={compact} />
        </section>
      )}
      {nextTask ? (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-3" aria-label="Suggested next task" role="group">
          <div className="flex items-center gap-2 text-sm font-medium text-muted">
            Try next {newTasks.has(nextTask.id) && <Badge tone="accent">Changed since {tester.since}</Badge>}
          </div>
          <Link to={nextTask.to} className="mt-0.5 block text-sm font-semibold hover:text-accent">
            {nextTask.label}
          </Link>
          <p className="mt-0.5 text-xs text-muted">{nextTask.detail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <LinkButton to={nextTask.to} size="sm" variant="primary" icon={ArrowRight}>
                Go
              </LinkButton>
            <Button size="sm" variant="ghost" icon={Check} onClick={() => w.toggleTask(nextTask.id)}>
              I’ve done this
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-xl bg-ok-soft p-3 text-sm text-ok">You’ve tried everything suggested for this role.</p>
      )}
      <div className="text-xs text-muted">
        {doneCount} of {tasks.length} done
      </div>
      <Disclosure tone="muted" title="Choose another task" summary={`${tasks.length - doneCount} left`}>
        {(() => {
          const row = (t: (typeof tasks)[number]) => (
            <li key={t.id} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-2.5">
              <button
                onClick={() => w.toggleTask(t.id)}
                className={cx('mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded border', w.done[t.id] ? 'border-accent bg-accent text-accent-fg' : 'border-control')}
                aria-label={w.done[t.id] ? 'Mark not done' : 'Mark done'}
              >
                {w.done[t.id] && <Check className="size-3" />}
              </button>
              <div className="min-w-0 flex-1">
                <Link to={t.to} className={cx('text-sm font-medium hover:text-accent', w.done[t.id] && 'text-muted line-through')}>
                  {t.label}
                </Link>
                {newTasks.has(t.id) && (
                  <Badge tone="accent" className="ml-2">
                    Changed
                  </Badge>
                )}
                {!compact || !w.done[t.id] ? <p className="text-xs text-muted">{t.detail}</p> : null}
              </div>
              <Link to={t.to} className="mt-0.5 text-muted hover:text-accent" aria-label="Go">
                <ArrowRight className="size-4" />
              </Link>
            </li>
          );
          const todo = tasks.filter((t) => !w.done[t.id]);
          const finished = tasks.filter((t) => w.done[t.id]);
          return (
            <div className="space-y-3">
              {todo.length > 0 && (
                <ul className="space-y-1.5" aria-label="Still to try">
                  {todo.map(row)}
                </ul>
              )}
              {finished.length > 0 && (
                <div>
                  <h4 className="mb-1.5 text-sm font-semibold">Done ({finished.length})</h4>
                  <ul className="space-y-1.5" aria-label="Done">
                    {finished.map(row)}
                  </ul>
                </div>
              )}
            </div>
          );
        })()}
      </Disclosure>
      <Button variant="primary" size="sm" icon={ArrowRight} onClick={w.next}>
        Next: simulate the others
      </Button>
    </div>
  );
}

function SimulateStep() {
  const w = useWalkthrough();
  const demo = useDemoOntology();
  const { session, setSession, now } = useSession();
  const [events, setEvents] = useState<ActivityItem[]>([]);
  const step = useAction(async () => {
    if (!demo) return;
    const r = await api.simulationStep(demo.id);
    setEvents((prev) => [...(r.events ?? []), ...prev]);
  });
  const clock = useAction(async (days: number) => setSession(await api.advanceClock(days)));
  const reset = useAction(async () => {
    await api.resetSimulation();
    setEvents([]);
  });
  if (!session?.user) return <p className="text-sm text-muted">Pick a role first.</p>;
  return (
    <div className="space-y-3 text-sm">
      <p>Governance usually takes days. Make the simulated participants act — they comment, review, vote and add use cases — then fast-forward the clock so review periods end and votes close.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={Play} loading={step.pending} onClick={() => void step.run()} disabled={!demo}>
          Simulate the others
        </Button>
        <Button icon={FastForward} loading={clock.pending} onClick={() => void clock.run(1)}>
          +1 day
        </Button>
        <Button icon={FastForward} onClick={() => void clock.run(7)} disabled={clock.pending}>
          +7 days
        </Button>
      </div>
      <p className="text-xs text-muted">Simulated time: {formatDate(new Date(now()).toISOString(), true)}</p>
      <InlineError error={step.error || clock.error || reset.error} />
      {events.length > 0 && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-1">
          <ActivityList items={events} compact />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={ArrowRight} onClick={w.next}>
          I’m ready to give feedback
        </Button>
        <Button size="sm" variant="ghost" icon={RotateCcw} loading={reset.pending} onClick={() => void reset.run()}>
          Reset simulation
        </Button>
      </div>
    </div>
  );
}

function FeedbackStep({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p>Thank you for trying Concord. When you’re ready, tell us what worked and what didn’t — by typing or just talking. It takes about 8 minutes, or you can leave a quick note.</p>
      <LinkButton to="/feedback" onClick={onNavigate} variant="primary" icon={MessageSquareHeart}>
          Give feedback
        </LinkButton>
    </div>
  );
}

export function StepBody({ step, compact, onNavigate }: { step: number; compact?: boolean; onNavigate?: () => void }) {
  switch (STEPS[step]?.id) {
    case 'welcome':
      return <WelcomeStep />;
    case 'role':
      return <RoleStep compact={compact} />;
    case 'tour':
      return <TourStep compact={compact} />;
    case 'simulate':
      return <SimulateStep />;
    default:
      return <FeedbackStep onNavigate={onNavigate} />;
  }
}

/* --------------------------------------------------------------- floating pill + panel */

export function WalkthroughDock() {
  const w = useWalkthrough();
  const loc = useLocation();
  const nav = useNavigate();
  if (!showWalkthroughDock(loc.pathname)) return null;
  return (
    <>
      {!w.open && (
        <button
          onClick={() => w.setOpen(true)}
          aria-label={`Walkthrough, step ${w.step + 1} of ${STEPS.length}`}
          className="fixed right-4 bottom-4 z-40 inline-flex size-11 items-center justify-center rounded-full border border-line-strong bg-surface text-sm font-medium shadow-lg hover:bg-surface-2 md:w-auto md:gap-2 md:rounded-pill md:px-4"
        >
          <Compass className="size-4 shrink-0 text-accent" aria-hidden />
          <span className="hidden md:inline">Step {w.step + 1} of {STEPS.length}</span>
          <span aria-hidden className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-accent-fg md:hidden">{w.step + 1}</span>
        </button>
      )}
      {w.open && (
        <aside className="fixed right-0 bottom-0 z-40 flex max-h-[85vh] w-full flex-col border-t border-line bg-bg shadow-2xl sm:right-4 sm:bottom-4 sm:w-[380px] sm:rounded-2xl sm:border">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Compass className="size-4 text-accent" /> Alpha walkthrough
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => nav('/alpha')}>
                Full view
              </Button>
              <button className="rounded-md p-1 text-muted hover:bg-surface-2" onClick={() => w.setOpen(false)} aria-label="Close walkthrough">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <div className="text-sm font-medium text-muted">
              Step {w.step + 1}: {STEPS[w.step].title}
            </div>
            <Popover label="All walkthrough steps" align="right" className="px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg" trigger={<>Steps</>}>
              {(close) => (
                <ol className="space-y-1">
                  {STEPS.map((st, i) => (
                    <li key={st.id}>
                      <button
                        className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2', i === w.step && 'font-medium text-accent')}
                        aria-current={i === w.step ? 'step' : undefined}
                        onClick={() => {
                          w.setStep(i);
                          close();
                        }}
                      >
                        <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.65rem]', i < w.step ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>
                          {i < w.step ? <Check className="size-3" /> : i + 1}
                        </span>
                        {st.title}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </Popover>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <StepBody step={w.step} compact onNavigate={() => w.setOpen(false)} />
          </div>
          <div className="flex justify-between border-t border-line px-4 py-2">
            <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={w.step === 0} onClick={w.prev}>
              Back
            </Button>
            <Button size="sm" variant="ghost" disabled={w.step === STEPS.length - 1} onClick={w.next}>
              Skip <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </aside>
      )}
    </>
  );
}

