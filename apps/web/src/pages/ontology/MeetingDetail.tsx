import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Meeting, MeetingAnalysis, UseCase } from '@concord/shared';
import { ArrowLeft, Bot, CircleHelp, Gavel, Lightbulb, MessageSquare, MessageSquareWarning, PhoneOff, Repeat, Send, GitPullRequestDraft, ScanSearch } from 'lucide-react';
import { api, streamMeeting } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate, relativeTime, titleCase } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorCard, InlineError, Loading, Segmented, Spinner, Toggle } from '../../components/ui';
import { Disclosure } from '../../components/Disclosure';
import { Markdown } from '../../components/Markdown';
import { useOntology } from './Layout';
import { useSession } from '../../lib/session';
import { ChatToggle, MeetingStatus, useCanFacilitate } from './Meetings';

const SPEAKER_COLORS = ['#2563eb', '#c2410c', '#15803d', '#9333ea', '#be185d', '#0e7490', '#a16207', '#4f46e5'];

type View = 'summary' | 'transcript' | 'prompts' | 'extracted';
const VIEWS: [View, string][] = [
  ['summary', 'Summary'],
  ['transcript', 'Transcript'],
  ['prompts', 'Bot prompts'],
  ['extracted', 'Extracted items'],
];

function fmtT(t?: number) {
  if (t === undefined) return '';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MeetingDetailPage() {
  const { meetingId = '' } = useParams();
  const { id } = useOntology();
  const nav = useNavigate();
  const m = useAsync(() => api.meeting(meetingId), [meetingId]);
  const [view, setView] = useState<View>('summary');
  const [proposed, setProposed] = useState<{ useCases: UseCase[]; changeRequestId?: string }>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = m.data?.status === 'live';
  const scheduled = m.data?.status === 'scheduled';
  const waitingBot = !!m.data?.bot && ['scheduled', 'joining', 'in-call'].includes(m.data.bot.status) && !live && !scheduled;
  const processing = m.data?.status === 'processing';

  // Live updates over SSE while the meeting is live.
  useEffect(() => {
    if (!live) return;
    return streamMeeting(
      meetingId,
      (ev) => {
        if (ev.type === 'line') m.setData((p) => (p ? { ...p, transcript: [...p.transcript, ev.line] } : (p as unknown as Meeting)));
        else if (ev.type === 'prompt') m.setData((p) => (p ? { ...p, facilitatorPrompts: [...p.facilitatorPrompts, ev.prompt] } : (p as unknown as Meeting)));
        else if (ev.type === 'meeting') m.setData(ev.meeting);
        else if (ev.type === 'status') {
          if (ev.meeting) m.setData(ev.meeting);
          else m.setData((p) => (p ? { ...p, status: ev.status } : (p as unknown as Meeting)));
          if (ev.status !== 'live') void m.reload();
        }
      },
      () => void m.reload(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, meetingId]);

  // Poll while the bot is joining or analysis is running.
  useEffect(() => {
    if (!waitingBot && !processing) return;
    const t = setInterval(() => void m.reload(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingBot, processing]);

  // A call from a calendar invite: check now and then for the bot being booked or joining.
  useEffect(() => {
    if (!scheduled) return;
    const t = setInterval(() => void m.reload(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled]);

  useEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [m.data?.transcript.length, live]);

  const colorFor = useMemo(() => {
    const speakers = [...new Set((m.data?.transcript ?? []).map((l) => l.speaker))];
    return (s: string) => SPEAKER_COLORS[Math.max(0, speakers.indexOf(s)) % SPEAKER_COLORS.length];
  }, [m.data?.transcript]);

  const analyse = useAction(async () => m.setData(await api.analyseMeeting(meetingId)));
  const canFacilitate = useCanFacilitate();
  const update = useAction(async (changes: { postPromptsToChat?: boolean; skip?: boolean; approve?: boolean }) => m.setData(await api.updateMeeting(meetingId, changes)));
  const end = useAction(async () => {
    try {
      m.setData(await api.endMeeting(meetingId));
    } finally {
      // If the bot couldn't be removed, the meeting now says so; show it.
      void m.reload();
    }
  });
  const { session } = useSession();
  const [posting, setPosting] = useState<number>();
  const postPrompt = useAction(async (i: number) => {
    setPosting(i);
    try {
      m.setData(await api.postPrompt(meetingId, i));
    } finally {
      setPosting(undefined);
      // The prompt records why posting failed; show it even when the request failed.
      void m.reload();
    }
  });
  const propose = useAction(async () => {
    const r = await api.proposeFromMeeting(meetingId);
    setProposed({ useCases: r.useCases, changeRequestId: r.changeRequest?.id });
    if (r.changeRequest) nav(`/o/${id}/changes/${r.changeRequest.id}`);
  });

  if (m.error && !m.data) return <ErrorCard error={m.error} onRetry={m.reload} />;
  if (!m.data) return <Loading />;
  const mt = m.data;
  const a = mt.analysis;
  // Posting into the meeting chat needs a bot in the call (or a simulated one).
  const mayRun = canFacilitate(mt);
  // Uploaders and whoever ran a simulation can analyse their own calls too.
  const mayAnalyse = mayRun || (mt.createdBy === session?.user?.id && (mt.source === 'upload' || mt.source === 'simulation'));
  const botInCall = mt.bot?.status === 'joining' || mt.bot?.status === 'in-call';
  const hasChat = mt.source === 'simulation' || mt.source === 'google-meet-bot' || mt.source === 'calendar-invite';
  const canPostNow = live && (mt.source === 'simulation' || (mt.bot?.provider === 'recall' && ['joining', 'in-call'].includes(mt.bot.status)));

  const transcriptCard = (
    <Card>
      <CardHeader title="Transcript" subtitle={live ? 'Streaming live…' : `${mt.transcript.length} lines`} actions={live ? <Spinner /> : undefined} />
      <div ref={scrollRef} className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
        {waitingBot && !mt.transcript.length && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> The bot is {mt.bot?.status === 'in-call' ? 'in the call — transcript will appear shortly' : `${mt.bot?.status}…`}
          </div>
        )}
        {scheduled && mt.calendar && (
          <p className="text-sm text-muted">
            {mt.calendar.approval === 'pending'
              ? `The bot was invited${mt.calendar.organizer ? ` (organiser: ${mt.calendar.organizer})` : ''}. It won’t join until one of the ontology’s owners, stewards or editors approves${mt.calendar.recurring ? ' the series' : ''}.`
              : mt.calendar.skip
                ? 'The bot is skipping this call.'
                : `The bot joins when the call starts, ${relativeTime(mt.calendar.start)}. The host may need to admit it. The transcript streams in here live.`}
          </p>
        )}
        {!mt.transcript.length && !waitingBot && !scheduled && <p className="text-sm text-muted">No transcript yet.</p>}
        {mt.transcript.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[0.7rem] text-subtle">{fmtT(l.t)}</span>
            <div className="min-w-0">
              <span className="text-xs font-semibold" style={{ color: colorFor(l.speaker) }}>
                {l.speaker}
              </span>
              <p className="text-sm leading-relaxed">{l.text}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
  const promptsCard = (
    <Card>
      <CardHeader icon={Bot} title="Co-lead bot prompts" subtitle="Gaps and follow-up questions the bot raised" />
      {hasChat && mayRun && (live || scheduled) && (
        <div className="border-b border-line px-5 py-3">
          <ChatToggle checked={!!mt.postPromptsToChat} onChange={(v) => void update.run({ postPromptsToChat: v })} disabled={update.pending} />
          {mt.chatNoticeError && (
            <p className="mt-2 text-xs text-danger" data-testid="chat-notice-error">
              {mt.chatNoticeError}
            </p>
          )}
        </div>
      )}
      <ul className="divide-y divide-line">
        {mt.facilitatorPrompts.map((p, i) => (
          <li key={i} className="flex gap-2 px-5 py-3 text-sm" data-testid="facilitator-prompt">
            {p.posted ? <MessageSquare className="mt-0.5 size-4 shrink-0 text-accent" /> : <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" />}
            <div className="min-w-0 flex-1">
              <p>{p.text}</p>
              <p className="mt-0.5 text-xs text-subtle">
                {fmtT(p.t)} {p.posted ? `· posted in the Meet chat${mt.source === 'simulation' ? ' (simulated)' : ''}` : '· suggested to the facilitator'}
              </p>
              {p.postError && !p.posted && <p className="mt-0.5 text-xs text-danger">Couldn’t post: {p.postError}</p>}
              {!p.posted && canPostNow && mayRun && (
                <Button size="sm" variant="ghost" icon={Send} className="-ml-2 mt-1" loading={posting === i} disabled={posting !== undefined} onClick={() => void postPrompt.run(i)}>
                  Post in the Meet chat
                </Button>
              )}
            </div>
          </li>
        ))}
        {!mt.facilitatorPrompts.length && <li className="px-5 py-4 text-sm text-muted">{live ? 'Listening for gaps…' : 'No prompts were raised.'}</li>}
      </ul>
    </Card>
  );
  // After the call, show a summary first; transcript, prompts and extracted items are a click away.
  const showViews = !live && !scheduled && !processing;

  return (
    <div>
      <Link to={`/o/${id}/meetings`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Meetings
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{mt.title}</h2>
            <MeetingStatus m={mt} />
          </div>
          <p className="text-xs text-muted">
            {formatDate(mt.createdAt, true)}
            {mt.meetingUrl && (
              <>
                {' '}
                ·{' '}
                <a href={mt.meetingUrl} className="text-accent hover:underline" target="_blank" rel="noreferrer">
                  {mt.meetingUrl}
                </a>
              </>
            )}
            {mt.bot && <> · bot via {mt.bot.provider}</>}
          </p>
          {mt.calendar && (
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted" data-testid="meeting-calendar">
              From a calendar invite: {formatDate(mt.calendar.start, true)}
              {mt.calendar.recurring && (
                <>
                  {' '}
                  · <Repeat className="size-3" /> part of a series
                </>
              )}
              {mt.calendar.organizer && <> · organised by {mt.calendar.organizer}</>}
            </p>
          )}
          {mt.calendar?.approvalNote && (
            <p className="mt-1 text-sm text-warn" data-testid="approval-note">
              {mt.calendar.approvalNote}
              {scheduled && mt.calendar.approval === 'pending' && ' A facilitator needs to approve it again.'}
            </p>
          )}
          {mt.bot?.leaving && <p className="mt-1 text-sm text-warn">You ended the call, but the bot couldn’t be removed yet. Concord keeps trying and analyses the call once it has left.</p>}
          {mt.bot?.error && <p className="mt-1 text-sm text-danger">Bot error: {mt.bot.error}</p>}
          {mt.bot?.cancelError && (
            <p className="mt-1 text-sm text-warn" data-testid="cancel-error">
              The bot booked earlier hasn’t been cancelled yet ({mt.bot.cancelError}). Concord keeps trying, and ignores anything it sends meanwhile.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {scheduled && mt.calendar && mayRun && mt.calendar.approval === 'pending' && (
            <Button variant="primary" loading={update.pending} onClick={() => void update.run({ approve: true })}>
              {mt.calendar.recurring ? 'Approve the bot for this series' : 'Approve the bot joining'}
            </Button>
          )}
          {scheduled && mt.calendar && mayRun && mt.calendar.approval !== 'pending' && (
            <span className="inline-flex items-center gap-2 text-sm">
              <Toggle checked={!mt.calendar.skip} onChange={(v) => void update.run({ skip: !v })} disabled={update.pending} ariaLabel="Bot joins this call" />
              <span aria-hidden>{mt.calendar.skip ? 'Skipping this call' : 'Bot joins this call'}</span>
            </span>
          )}
          {live && mayRun && (
            <Button icon={PhoneOff} loading={end.pending} onClick={() => void end.run()}>
              End call and analyse
            </Button>
          )}
          {!a && mt.status !== 'live' && !botInCall && mayAnalyse && (
            <Button icon={ScanSearch} loading={analyse.pending || processing} onClick={() => void analyse.run()} disabled={!mt.transcript.length}>
              Analyse transcript
            </Button>
          )}
          {a && (
            <Button variant="primary" icon={GitPullRequestDraft} loading={propose.pending} onClick={() => void propose.run()}>
              Turn into use cases and a change request
            </Button>
          )}
        </div>
      </div>
      <InlineError error={analyse.error || propose.error || update.error || end.error} />
      {proposed && !proposed.changeRequestId && (
        <Card className="mb-4 p-4 text-sm">
          Created {proposed.useCases.length} use case{proposed.useCases.length === 1 ? '' : 's'}.{' '}
          <Link to={`/o/${id}/use-cases`} className="text-accent hover:underline">
            Review them
          </Link>
          .
        </Card>
      )}

      {showViews && a ? (
        <>
          <Segmented
            className="mb-4"
            label="Meeting views"
            value={view}
            onChange={setView}
            options={VIEWS.map(([key, label]) => ({
              value: key,
              label: (
                <>
                  {label}
                  {key === 'prompts' && <span className="text-subtle">{mt.facilitatorPrompts.length}</span>}
                  {key === 'extracted' && <span className="text-subtle">{a.useCases.length + a.terms.length + a.competencyQuestions.length + a.openQuestions.length}</span>}
                </>
              ),
            }))}
          />
          {view === 'summary' && <SummaryView a={a} prompts={mt.facilitatorPrompts.length} lines={mt.transcript.length} onOpen={setView} />}
          {view === 'transcript' && transcriptCard}
          {view === 'prompts' && promptsCard}
          {view === 'extracted' && <ExtractedView a={a} />}
        </>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          {transcriptCard}
          <div className="space-y-4">
            {promptsCard}
            {a ? (
              <SummaryView a={a} prompts={mt.facilitatorPrompts.length} lines={mt.transcript.length} />
            ) : (
              <EmptyState icon={ScanSearch} title={live ? 'Analysis runs when the call ends' : processing ? 'Analysing…' : 'Not analysed yet'}>
                {live ? 'Keep watching — the transcript and bot prompts update live.' : 'Run the analysis to extract use cases, terms and questions.'}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon?: typeof Bot; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {Icon && <Icon className="size-3.5" />}
        {title}
      </h4>
      {children}
    </div>
  );
}

/** What a finished call came to: the summary, decisions and open disagreements, with counts of what was extracted. */
function SummaryView({ a, prompts, lines, onOpen }: { a: MeetingAnalysis; prompts: number; lines: number; onOpen?: (v: View) => void }) {
  const counts: [string, number, View][] = [
    ['use cases', a.useCases.length, 'extracted'],
    ['terms', a.terms.length, 'extracted'],
    ['competency questions', a.competencyQuestions.length, 'extracted'],
    ['open questions', a.openQuestions.length, 'extracted'],
    ['bot prompts', prompts, 'prompts'],
    ['transcript lines', lines, 'transcript'],
  ];
  return (
    <Card>
      <CardHeader icon={ScanSearch} title="Summary" />
      <div className="space-y-5 p-5 text-sm">
        <Markdown text={a.summary} />
        <ul className="flex flex-wrap gap-2" aria-label="What the call produced">
          {counts.map(([label, n, v]) => (
            <li key={label}>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(v)} className="rounded-lg border border-line px-2.5 py-1.5 text-left hover:border-accent hover:text-accent">
                  <span className="font-semibold tabular-nums">{n}</span> <span className="text-xs text-muted">{label}</span>
                </button>
              ) : (
                <span className="inline-block rounded-lg border border-line px-2.5 py-1.5">
                  <span className="font-semibold tabular-nums">{n}</span> <span className="text-xs text-muted">{label}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
        {a.decisions.length > 0 && (
          <Section title="Decisions" icon={Gavel}>
            <ul className="list-disc space-y-1 pl-5">
              {a.decisions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
        )}
        {a.disagreements.length > 0 && (
          <Section title="Unresolved disagreements" icon={MessageSquareWarning}>
            <ul className="space-y-2">
              {a.disagreements.map((d, i) => (
                <li key={i} className="rounded-lg bg-warn-soft p-2.5">
                  <div className="font-medium">{d.topic}</div>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {d.positions.map((p, j) => (
                      <li key={j}>
                        <strong>{p.speaker}:</strong> {p.position}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Card>
  );
}

/** Use cases, terms (with the speakers' words one click away), competency and open questions. */
function ExtractedView({ a }: { a: MeetingAnalysis }) {
  const none = !a.useCases.length && !a.terms.length && !a.competencyQuestions.length && !a.openQuestions.length;
  return (
    <Card>
      <CardHeader icon={ScanSearch} title="Extracted items" subtitle="What Concord found in the call, to turn into use cases and a change request" />
      <div className="space-y-5 p-5 text-sm">
        {none && <p className="text-muted">Nothing was extracted from this call.</p>}
        {a.useCases.length > 0 && (
          <Section title={`Use cases (${a.useCases.length})`}>
            <ul className="space-y-2">
              {a.useCases.map((u, i) => (
                <li key={i} className="rounded-lg border border-line p-2.5">
                  <div className="font-medium">{u.title}</div>
                  {u.speaker && <div className="text-xs text-muted">raised by {u.speaker}</div>}
                  {u.sections.goal && <p className="mt-1 text-xs">{u.sections.goal}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {a.terms.length > 0 && (
          <Section title={`Terms (${a.terms.length})`}>
            <ul className="space-y-3">
              {a.terms.map((t, i) => (
                <li key={i}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{t.label}</span>
                    <Badge tone="outline">{titleCase(t.kind.replace(/([A-Z])/g, ' $1'))}</Badge>
                    {t.existingIri && <Badge tone="ok">exists</Badge>}
                  </div>
                  {t.definition && <p className="text-xs text-muted">{t.definition}</p>}
                  {!!t.evidence?.length && (
                    <Disclosure className="mt-1" tone="muted" title={<span className="text-xs">What was said ({t.evidence.length})</span>}>
                      {t.evidence.map((e, j) => (
                        <blockquote key={j} className="mt-1 border-l-2 border-line-strong pl-2 text-xs text-subtle italic">
                          “{e}”
                        </blockquote>
                      ))}
                    </Disclosure>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {a.competencyQuestions.length > 0 && (
          <Section title={`Competency questions (${a.competencyQuestions.length})`} icon={CircleHelp}>
            <ul className="list-disc space-y-1 pl-5">
              {a.competencyQuestions.map((q, i) => (
                <li key={i}>
                  {q.question} {q.askedBy && <span className="text-xs text-muted">— {q.askedBy}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {a.openQuestions.length > 0 && (
          <Section title={`Open questions (${a.openQuestions.length})`}>
            <ul className="list-disc space-y-1 pl-5">
              {a.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Card>
  );
}
