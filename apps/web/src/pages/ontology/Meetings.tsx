import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Meeting, MeetBotInfo } from '@concord/shared';
import { Bot, CalendarClock, CalendarPlus, ClipboardPaste, FileUp, Mail, Play, Plus, Radio, Repeat, Users, Video } from 'lucide-react';
import { Popover } from '../../components/Disclosure';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, plural, relativeTime, titleCase } from '../../lib/format';
import { Badge, Button, Card, CardHeader, CopyButton, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Segmented, Textarea, Toggle } from '../../components/ui';
import { useOntology } from './Layout';

export function MeetingStatus({ m }: { m: Meeting }) {
  if (m.status === 'scheduled')
    return (
      <Badge tone={m.calendar?.skip ? 'neutral' : 'accent'} icon={CalendarClock}>
        {m.calendar?.approval === 'pending' ? 'Needs approval' : m.calendar?.skip ? 'Bot skipping' : isBooked(m) ? 'Bot booked' : 'Scheduled'}
      </Badge>
    );
  if (m.status === 'live' && m.bot?.status === 'joining')
    return (
      <Badge tone="accent" icon={Radio}>
        Bot joining
      </Badge>
    );
  if (m.status === 'live')
    return (
      <Badge tone="danger" icon={Radio}>
        Live
      </Badge>
    );
  if (m.bot && m.bot.status !== 'done' && m.status !== 'analysed')
    return <Badge tone={m.bot.status === 'error' ? 'danger' : 'accent'}>Bot: {titleCase(m.bot.status)}</Badge>;
  return <Badge tone={m.status === 'analysed' ? 'ok' : m.status === 'error' ? 'danger' : 'neutral'}>{titleCase(m.status)}</Badge>;
}

const SOURCE_LABEL: Record<Meeting['source'], string> = {
  upload: 'Uploaded transcript',
  'google-meet-bot': 'Google Meet (co-lead bot)',
  'calendar-invite': 'Google Meet (calendar invite)',
  simulation: 'Simulated call',
  'google-drive': 'Google Drive',
};

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { id } = useOntology();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [source, setSource] = useState<'file' | 'paste'>('file');
  const upload = useAction(async () => {
    const m = await api.uploadMeeting(id, title.trim() || fileName || 'Uploaded meeting', text);
    onClose();
    nav(`/o/${id}/meetings/${m.id}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload a meeting transcript"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={upload.pending} disabled={!text.trim()} onClick={() => void upload.run()}>
            Upload and analyse
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Working group call — 12 March" />
        </Field>
        <Segmented
          label="How to add the transcript"
          value={source}
          onChange={setSource}
          options={[
            { value: 'file', label: 'From a file', icon: FileUp },
            { value: 'paste', label: 'Paste text', icon: ClipboardPaste },
          ]}
        />
        {source === 'file' ? (
          <Field label="Transcript file" hint="Google Meet / Gemini notes, .vtt, .srt, or plain “Speaker: text” lines.">
            <input
              type="file"
              accept=".txt,.vtt,.srt,.md,text/plain,text/vtt"
              aria-label="Transcript file"
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-surface-2"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name.replace(/\.[^.]+$/, ''));
                setText(await f.text());
              }}
            />
          </Field>
        ) : (
          <Field label="Transcript">
            <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder={'Amira: We need to know which volunteers are DBS checked.\nTom: And when the check expires…'} />
          </Field>
        )}
        {source === 'file' && fileName && text && <p className="text-xs text-muted">{fileName}: {text.split('\n').filter((l) => l.trim()).length} lines read</p>}
        <InlineError error={upload.error} />
      </div>
    </Dialog>
  );
}

/** "concord.bot@gmail.com" → "concord.bot+volunteering@gmail.com", so invites to it are filed under this ontology. */
export function plusAddress(email: string, slug: string) {
  const [local, domain] = email.split('@');
  return domain ? `${local}+${slug}@${domain}` : email;
}

type BotMode = 'email' | 'link' | 'ics';

/** Facilitators (owners, stewards, editors) run calls. */
export function useCanFacilitate() {
  const { hasRole } = useOntology();
  const { session } = useSession();
  // Only the ontology's owners, stewards and editors run calls (the server checks the same).
  return (_m?: Pick<Meeting, 'ontologyId'>) => !!session?.user?.isPlatformAdmin || hasRole('owner', 'steward', 'editor');
}

export function ChatToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label="Post prompts in the Meet chat automatically" />
      <p className="mt-1 pl-11 text-xs text-muted">
        {checked ? 'Everyone in the call sees each new follow-up question in the chat.' : 'Follow-up questions show only in Concord, for the facilitator to raise or post one by one.'} The bot transcribes either way, and tells the call
        when this changes. Agree it with the people in the call.
      </p>
    </div>
  );
}

function BotDialog({
  open,
  onClose,
  onScheduled,
  bot,
  ontology,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: (notice?: string) => void;
  bot?: MeetBotInfo;
  ontology: { id: string; slug: string; title: string };
}) {
  const { id } = ontology;
  const nav = useNavigate();
  const [mode, setMode] = useState<BotMode>(bot?.inviteEmail ? 'email' : 'link');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [ics, setIcs] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [postToChat, setPostToChat] = useState(bot?.postToChatDefault ?? false);
  const valid = /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(url.trim());
  const invite = useAction(async () => {
    const m = await api.inviteBot(id, title.trim() || 'Google Meet call', url.trim(), postToChat);
    onClose();
    nav(`/o/${id}/meetings/${m.id}`);
  });
  const schedule = useAction(async () => {
    const { meetings: ms, cancelled, cancelRetrying } = await api.scheduleFromInvite(id, ics, postToChat);
    onClose();
    if (ms.length === 1 && !cancelled && !cancelRetrying) nav(`/o/${id}/meetings/${ms[0].id}`);
    else
      onScheduled(
        [
          cancelled ? `The bot won’t join ${cancelled === 1 ? 'the cancelled call' : `the ${cancelled} cancelled calls`}.` : '',
          cancelRetrying ? `Recall.ai hasn’t confirmed cancelling the bot for ${cancelRetrying === 1 ? 'one call' : `${cancelRetrying} calls`} yet; Concord keeps trying.` : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      );
  });
  const preview = ics ? icsPreview(ics) : undefined;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bring the co-lead bot to a Google Meet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {mode === 'email' ? 'Done' : 'Cancel'}
          </Button>
          {mode === 'link' && (
            <Button variant="primary" icon={Bot} loading={invite.pending} disabled={!valid} onClick={() => void invite.run()}>
              Send the bot now
            </Button>
          )}
          {mode === 'ics' && (
            <Button variant="primary" icon={CalendarPlus} loading={schedule.pending} disabled={!ics} onClick={() => void schedule.run()}>
              Import and schedule
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The bot joins as a participant, transcribes the call and acts as a co-facilitator: it spots gaps in the use case and suggests follow-up questions. Let everyone in the call know it’s there.
        </p>
        <Segmented
          label="How to bring the bot in"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'email', label: 'Schedule through Google Calendar', icon: Mail },
            { value: 'link', label: 'Join a call now', icon: Video },
            { value: 'ics', label: 'Import calendar occurrences', icon: CalendarPlus },
          ]}
        />

        {mode === 'email' &&
          (bot?.inviteEmail ? (
            <div className="space-y-3 text-sm">
              <p>Add the bot as a guest on the calendar invite, for one call or a whole recurring series, and put <strong>#{ontology.slug}</strong> in the invite’s title or description:</p>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]" data-testid="bot-invite-address">
                  {bot.inviteEmail}
                </code>
                <CopyButton text={bot.inviteEmail} label="Copy" />
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
                <li>Concord checks the bot’s calendar every minute; Google can take a few minutes to pass on a new or changed invite. Calls show under Upcoming calls here.</li>
                <li>An invite can’t prove who sent it, so each new invite waits for one of this ontology’s owners, stewards or editors to approve it, once for a whole series.</li>
                <li>Moving or cancelling the invite moves or cancels the bot. The host may need to admit it when it arrives.</li>
                <li>
                  Alternatively, invite <code className="font-mono">{plusAddress(bot.inviteEmail, ontology.slug)}</code> instead of using the tag (check it reaches the bot with your calendar first).
                </li>
              </ul>
              {!bot.calendarConnected && <p className="rounded-lg bg-warn-soft p-2.5 text-xs text-warn">The bot’s calendar isn’t connected on this server yet, so invites aren’t picked up. Import the invite (.ics) instead for now.</p>}
              {bot.lastSync && !bot.lastSync.ok && <p className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger">Couldn’t read the bot’s calendar: {bot.lastSync.error}</p>}
            </div>
          ) : (
            <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
              This server doesn’t have an email address for the bot yet. Send it into a call now, or import the calendar invite (.ics) to schedule it.
            </p>
          ))}

        {mode === 'link' && (
          <>
            <p className="text-xs text-muted">The bot is sent straight away and joins within a minute or so. The host may need to admit it.</p>
            <Field label="Meet link">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" inputMode="url" />
            </Field>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Use case workshop" />
            </Field>
            <ChatToggle checked={postToChat} onChange={setPostToChat} />
          </>
        )}

        {mode === 'ics' && (
          <>
            <p className="text-xs text-muted">
              A one-off import: the bot is scheduled for the calls in the next two weeks. Later changes to the invite aren’t picked up, so for a whole series, invite the bot’s address instead (or import again).
            </p>
            <Field label="Calendar invite" hint="In Google Calendar, open the event, then ⋮ › Download as .ics, or use the invite.ics attached to the invitation email.">
              <input
                type="file"
                accept=".ics,text/calendar"
                aria-label="Calendar invite file"
                className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-surface-2"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setFileName(f.name);
                  setIcs(await f.text());
                }}
              />
            </Field>
            {fileName && (
              <p className="text-xs text-muted" data-testid="ics-preview">
                {fileName}
                {preview && <>: {preview}</>}
              </p>
            )}
            <ChatToggle checked={postToChat} onChange={setPostToChat} />
          </>
        )}

        {mode !== 'email' && bot?.provider === 'simulated' && (
          <p className="rounded-lg bg-warn-soft p-2.5 text-xs text-warn">This server has no meeting-bot provider yet, so the bot won’t actually join your call. Run a simulated meeting to see what it does.</p>
        )}
        <InlineError error={invite.error || schedule.error} />
      </div>
    </Dialog>
  );
}

/** "Working group call, weekly": a quick read of an .ics file before importing it. */
function icsPreview(ics: string) {
  const summary = ics.match(/^SUMMARY:(.*)$/m)?.[1]?.trim();
  const weekly = /^RRULE:/m.test(ics);
  const cancelled = /^STATUS:CANCELLED/m.test(ics) || /^METHOD:CANCEL/m.test(ics);
  if (!summary) return cancelled ? 'a cancellation' : undefined;
  return `“${summary}”${weekly ? ', a recurring series' : ''}${cancelled ? ' (includes a cancellation)' : ''}`;
}

/** Facilitators see the bot's id; everyone else just whether one is booked. */
const isBooked = (m: Meeting) => (m.bot?.phase ? m.bot.phase === 'booked' : !!(m.bot?.botId || m.bot?.booked));

/** Where the bot stands for one upcoming call: what will happen, separate from the switch saying what should. */
function BookingState({ m }: { m: Meeting }) {
  if (m.calendar?.approval === 'pending') return <Badge tone="warn" title={m.calendar.approvalNote}>{m.calendar.approvalNote ? 'Needs approval again' : 'Needs approval'}</Badge>;
  if (m.calendar?.skip) return <Badge tone="neutral">Skipping</Badge>;
  if (m.withdrawn) return <Badge tone="neutral" title={m.bot?.cancelError}>Cancelled; making sure the bot has gone</Badge>;
  if (m.calendar?.cancelPending) return <Badge tone="danger">Cancelling the bot failed; retrying</Badge>;
  if (m.bot?.cancelError && !isBooked(m)) return <Badge tone="warn" title={m.bot.cancelError}>Cancelling the old bot; retrying</Badge>;
  if (m.bot?.phase === 'releasing') return <Badge tone="warn">Cancelling the old bot</Badge>;
  if (m.bot?.unconfirmed) return <Badge tone="warn" title={m.bot.error}>Booking unconfirmed</Badge>;
  if (m.bot?.provider === 'simulated') return <Badge tone="neutral" title={m.bot.error}>No bot provider on this server</Badge>;
  if (isBooked(m) && m.bot?.error) return <Badge tone="danger" title={m.bot.error}>Cancelling the bot failed; retrying</Badge>;
  if (isBooked(m)) return <Badge tone="ok">Bot booked</Badge>;
  if (m.bot?.uncertain) return <Badge tone="warn" title={m.bot.error}>Checking an unconfirmed booking</Badge>;
  if (m.bot?.error) return <Badge tone="danger" title={m.bot.error}>Booking failed; retrying</Badge>;
  return <Badge tone="outline">Books 15 min before</Badge>;
}

function UpcomingCalls({ calls, onChange, bot }: { calls: Meeting[]; onChange: () => void; bot?: MeetBotInfo }) {
  const { id } = useOntology();
  const { now } = useSession();
  const canFacilitate = useCanFacilitate();
  const update = useAction(async (m: Meeting, changes: { skip?: boolean; approve?: boolean }) => {
    await api.updateMeeting(m.id, changes);
    onChange();
  });
  if (!calls.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader
        icon={CalendarClock}
        title="Upcoming calls"
        subtitle={
          <>
            From calendar invites. The bot joins each approved call when it starts; a facilitator approves each new invite once, for the whole series.
            {bot?.lastSync && <> Calendar {bot.lastSync.ok ? 'checked' : 'check failed'} {relativeTime(bot.lastSync.at, now())}.</>}
            {!!bot?.cancelling && <span data-testid="bots-cancelling"> Still cancelling {bot.cancelling === 1 ? 'one bot' : `${bot.cancelling} bots`} with Recall.ai; retried every minute.</span>}
          </>
        }
      />
      <ul className="divide-y divide-line">
        {calls.map((m) => {
          const when = formatDate(m.calendar?.start, true);
          const mine = canFacilitate(m);
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Link to={`/o/${id}/meetings/${m.id}`} className="min-w-0 flex-1 hover:underline">
                <div className="font-medium">{m.title}</div>
                <div className="flex items-center gap-1 text-xs text-muted">
                  {when}
                  {m.calendar?.recurring && (
                    <>
                      {' '}
                      · <Repeat className="size-3" /> part of a series
                    </>
                  )}
                  {m.calendar?.organizer && <> · organiser: {m.calendar.organizer}</>}
                </div>
                {m.calendar?.approvalNote && <div className="text-xs text-warn">{m.calendar.approvalNote}</div>}
              </Link>
              <BookingState m={m} />
              {mine && m.calendar?.approval === 'pending' && (
                <Button size="sm" variant="primary" loading={update.pending} onClick={() => void update.run(m, { approve: true })}>
                  Approve
                </Button>
              )}
              {mine && m.calendar?.approval !== 'pending' && (
                <Toggle checked={!m.calendar?.skip} onChange={(v) => void update.run(m, { skip: !v })} disabled={update.pending} ariaLabel={`Bot joins “${m.title}” on ${when}`} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="px-5 pb-3">
        <InlineError error={update.error} />
      </div>
    </Card>
  );
}

export function MeetingsTab() {
  const { id, ontology } = useOntology();
  const { session, now } = useSession();
  const nav = useNavigate();
  const list = useAsync(() => api.meetings(id), [id]);
  const botInfo = useAsync(() => api.meetBot(), []);
  const bot = botInfo.data ?? session?.meetBot;
  const canFacilitate = useCanFacilitate()();
  const upcoming = (list.data ?? []).filter((m) => m.status === 'scheduled').sort((a, b) => (a.calendar?.start ?? '').localeCompare(b.calendar?.start ?? ''));
  const past = (list.data ?? []).filter((m) => m.status !== 'scheduled');
  const [dialog, setDialog] = useState<'upload' | 'bot'>();
  const [notice, setNotice] = useState<string>();
  const simulate = useAction(async () => {
    const m = await api.simulateMeeting(id, 'Simulated working-group call');
    nav(`/o/${id}/meetings/${m.id}`);
  });
  const populated = !!list.data?.length;
  // Invites arrive, move and get skipped by other people: keep the list current while it's open.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void list.reload();
      void botInfo.reload();
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const botBody = !canFacilitate
    ? 'The ontology’s owners, stewards and editors can bring the bot into a call.'
    : bot?.inviteEmail
    ? 'Add its email address to a calendar invite, or paste a Meet link. It listens and raises gaps and follow-up questions live.'
    : 'It joins your Google Meet, listens, and raises gaps and follow-up questions live.';

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Meetings</h2>
          <p className="max-w-2xl text-sm text-muted">Turn conversations into use cases, terms, questions and decisions.</p>
        </div>
        {populated && (
          <Popover
            label="Add meeting"
            align="right"
            trigger={
              <>
                <Plus className="size-4" /> Add meeting
              </>
            }
            className="h-9 gap-2 rounded-lg border border-transparent bg-accent px-3.5 text-sm font-medium text-accent-fg shadow-sm hover:bg-accent-hover"
            panelClassName="w-72 p-1.5"
          >
            <div role="menu" aria-label="Add meeting" className="flex flex-col">
              <MenuItem icon={FileUp} title="Upload a transcript" body="Google Meet, Gemini notes, .vtt or .srt" onClick={() => setDialog('upload')} />
              {canFacilitate && <MenuItem icon={Video} title="Invite the co-lead bot" body={bot?.inviteEmail ? 'Through Google Calendar, now, or from an .ics' : 'Join a call now, or from an .ics'} onClick={() => setDialog('bot')} />}
              <MenuItem icon={Play} title="Run a simulated meeting" body="A scripted call, with the bot co-facilitating" onClick={() => void simulate.run()} />
            </div>
          </Popover>
        )}
      </div>
      {list.data && !populated && (
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <ActionCard icon={FileUp} title="Upload a transcript" body="From Google Meet, Gemini notes, Zoom (.vtt) or subtitles (.srt)." onClick={() => setDialog('upload')} cta="Upload" />
        <ActionCard
          icon={Video}
          title="Invite the co-lead bot"
          body={botBody}
          onClick={() => setDialog('bot')}
          cta="Invite to a Meet"
          disabled={!canFacilitate}
        />
        <ActionCard icon={Play} title="Run a simulated live meeting" body="Watch a scripted call unfold in real time, with the bot co-facilitating." onClick={() => void simulate.run()} cta="Start simulation" loading={simulate.pending} />
      </div>
      )}
      <InlineError error={simulate.error} />
      {notice && (
        <p role="status" className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <UpcomingCalls calls={upcoming} onChange={() => void list.reload()} bot={bot} />
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !past.length ? (
        upcoming.length ? null : (
          <EmptyState icon={Users} title="No meetings yet">
            Upload a transcript, invite the bot to your next call, or run a simulated meeting to see how it works.
          </EmptyState>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {past.map((m) => (
              <li key={m.id}>
                <Link to={`/o/${id}/meetings/${m.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs text-muted">
                      {SOURCE_LABEL[m.source]} · {m.transcript.length} lines · {relativeTime(m.createdAt, now())}
                    </div>
                  </div>
                  {m.analysis && <span className="text-xs text-muted">{plural(m.analysis.useCases.length, 'use case')} · {plural(m.analysis.terms.length, 'term')}</span>}
                  <MeetingStatus m={m} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <UploadDialog open={dialog === 'upload'} onClose={() => setDialog(undefined)} />
      {dialog === 'bot' && <BotDialog open onClose={() => setDialog(undefined)} onScheduled={(n) => {
            setNotice(n);
            void list.reload();
          }} bot={bot} ontology={ontology} />}
    </div>
  );
}

function MenuItem({ icon: Icon, title, body, onClick }: { icon: typeof Bot; title: string; body: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-accent" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
      </span>
    </button>
  );
}

function ActionCard({ icon: Icon, title, body, cta, onClick, loading, disabled }: { icon: typeof Bot; title: string; body: string; cta: string; onClick: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <Card className="flex flex-col p-4">
      <Icon className="mb-2 size-5 text-accent" />
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-1 flex-1 text-xs text-muted">{body}</p>
      <div className="mt-3">
        <Button size="sm" onClick={onClick} loading={loading} disabled={disabled}>
          {cta}
        </Button>
      </div>
    </Card>
  );
}
