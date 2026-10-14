import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Meeting, UseCase } from '@concord/shared';
import { ArrowLeft, Bot, CircleHelp, Gavel, Lightbulb, MessageSquareWarning, Sparkles, Wand2 } from 'lucide-react';
import { api, streamMeeting } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate, titleCase } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorCard, InlineError, Loading, Spinner } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { useOntology } from './Layout';
import { MeetingStatus } from './Meetings';

const SPEAKER_COLORS = ['#2563eb', '#c2410c', '#15803d', '#9333ea', '#be185d', '#0e7490', '#a16207', '#4f46e5'];

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
  const [proposed, setProposed] = useState<{ useCases: UseCase[]; changeRequestId?: string }>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = m.data?.status === 'live';
  const waitingBot = !!m.data?.bot && ['scheduled', 'joining', 'in-call'].includes(m.data.bot.status) && !live;
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
  const propose = useAction(async () => {
    const r = await api.proposeFromMeeting(meetingId);
    setProposed({ useCases: r.useCases, changeRequestId: r.changeRequest?.id });
    if (r.changeRequest) nav(`/o/${id}/changes/${r.changeRequest.id}`);
  });

  if (m.error && !m.data) return <ErrorCard error={m.error} onRetry={m.reload} />;
  if (!m.data) return <Loading />;
  const mt = m.data;
  const a = mt.analysis;

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
          {mt.bot?.error && <p className="mt-1 text-sm text-danger">Bot error: {mt.bot.error}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!a && mt.status !== 'live' && (
            <Button icon={Wand2} loading={analyse.pending || processing} onClick={() => void analyse.run()} disabled={!mt.transcript.length}>
              Analyse transcript
            </Button>
          )}
          {a && (
            <Button variant="primary" icon={Sparkles} loading={propose.pending} onClick={() => void propose.run()}>
              Turn into use cases and a change request
            </Button>
          )}
        </div>
      </div>
      <InlineError error={analyse.error || propose.error} />
      {proposed && !proposed.changeRequestId && (
        <Card className="mb-4 p-4 text-sm">
          Created {proposed.useCases.length} use case{proposed.useCases.length === 1 ? '' : 's'}.{' '}
          <Link to={`/o/${id}/use-cases`} className="text-accent hover:underline">
            Review them
          </Link>
          .
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader title="Transcript" subtitle={live ? 'Streaming live…' : `${mt.transcript.length} lines`} actions={live ? <Spinner /> : undefined} />
          <div ref={scrollRef} className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
            {waitingBot && !mt.transcript.length && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner /> The bot is {mt.bot?.status === 'in-call' ? 'in the call — transcript will appear shortly' : `${mt.bot?.status}…`}
              </div>
            )}
            {!mt.transcript.length && !waitingBot && <p className="text-sm text-muted">No transcript yet.</p>}
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

        <div className="space-y-4">
          <Card>
            <CardHeader icon={Bot} title="Co-lead bot prompts" subtitle="Gaps and follow-up questions the bot raised" />
            <ul className="divide-y divide-line">
              {mt.facilitatorPrompts.map((p, i) => (
                <li key={i} className="flex gap-2 px-5 py-3 text-sm">
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" />
                  <div>
                    <p>{p.text}</p>
                    <p className="mt-0.5 text-xs text-subtle">
                      {fmtT(p.t)} {p.posted ? '· posted in the meeting chat' : '· suggested to the facilitator'}
                    </p>
                  </div>
                </li>
              ))}
              {!mt.facilitatorPrompts.length && <li className="px-5 py-4 text-sm text-muted">{live ? 'Listening for gaps…' : 'No prompts were raised.'}</li>}
            </ul>
          </Card>

          {a ? (
            <Card>
              <CardHeader icon={Sparkles} title="Analysis" />
              <div className="space-y-5 p-5 text-sm">
                <Markdown text={a.summary} />
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
                    <ul className="space-y-2">
                      {a.terms.map((t, i) => (
                        <li key={i}>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{t.label}</span>
                            <Badge tone="outline">{titleCase(t.kind.replace(/([A-Z])/g, ' $1'))}</Badge>
                            {t.existingIri && <Badge tone="ok">exists</Badge>}
                          </div>
                          {t.definition && <p className="text-xs text-muted">{t.definition}</p>}
                          {t.evidence?.map((e, j) => (
                            <blockquote key={j} className="mt-1 border-l-2 border-line-strong pl-2 text-xs text-subtle italic">
                              “{e}”
                            </blockquote>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {a.competencyQuestions.length > 0 && (
                  <Section title="Competency questions" icon={CircleHelp}>
                    <ul className="list-disc space-y-1 pl-5">
                      {a.competencyQuestions.map((q, i) => (
                        <li key={i}>
                          {q.question} {q.askedBy && <span className="text-xs text-muted">— {q.askedBy}</span>}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {a.disagreements.length > 0 && (
                  <Section title="Disagreements" icon={MessageSquareWarning}>
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
                {a.openQuestions.length > 0 && (
                  <Section title="Open questions">
                    <ul className="list-disc space-y-1 pl-5">
                      {a.openQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </Section>
                )}
                {a.decisions.length > 0 && (
                  <Section title="Decisions" icon={Gavel}>
                    <ul className="list-disc space-y-1 pl-5">
                      {a.decisions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </Section>
                )}
              </div>
            </Card>
          ) : (
            <EmptyState icon={Sparkles} title={live ? 'Analysis runs when the call ends' : processing ? 'Analysing…' : 'Not analysed yet'}>
              {live ? 'Keep watching — the transcript and bot prompts update live.' : 'Run the analysis to extract use cases, terms and questions.'}
            </EmptyState>
          )}
        </div>
      </div>
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
