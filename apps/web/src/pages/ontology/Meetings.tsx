import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Meeting, MeetBotInfo } from '@concord/shared';
import { Bot, CalendarClock, CalendarPlus, FileUp, Mail, Play, Radio, Repeat, Users, Video } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime, titleCase } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Chip, CopyButton, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Textarea, Toggle } from '../../components/ui';
import { useOntology } from './Layout';

export function MeetingStatus({ m }: { m: Meeting }) {
  if (m.status === 'scheduled')
    return (
      <Badge tone={m.calendar?.skip ? 'neutral' : 'accent'} icon={CalendarClock}>
        {m.calendar?.skip ? 'Bot skipping' : m.bot?.botId ? 'Bot booked' : 'Scheduled'}
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
        <Field label="Transcript file" hint="Google Meet / Gemini notes, .vtt, .srt, or plain “Speaker: text” lines.">
          <input
            type="file"
            accept=".txt,.vtt,.srt,.md,text/plain,text/vtt"
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-surface-2"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name.replace(/\.[^.]+$/, ''));
              setText(await f.text());
            }}
          />
        </Field>
        <Field label="…or paste it here">
          <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder={'Amira: We need to know which volunteers are DBS checked.\nTom: And when the check expires…'} />
        </Field>
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

function ChatToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <Toggle checked={checked} onChange={onChange} label="Post the bot’s prompts in the Meet chat" />
      <p className="mt-1 pl-11 text-xs text-muted">
        {checked ? 'Everyone in the call sees its follow-up questions in the chat.' : 'Its follow-up questions only show here, for the facilitator to raise. You can post any of them, or switch this on, during the call.'}
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
  onScheduled: () => void;
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
    const ms = await api.scheduleFromInvite(id, ics, postToChat);
    onClose();
    if (ms.length === 1) nav(`/o/${id}/meetings/${ms[0].id}`);
    else onScheduled();
  });
  const address = bot?.inviteEmail ? plusAddress(bot.inviteEmail, ontology.slug) : undefined;
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
              Send the bot
            </Button>
          )}
          {mode === 'ics' && (
            <Button variant="primary" icon={CalendarPlus} loading={schedule.pending} disabled={!ics} onClick={() => void schedule.run()}>
              Schedule the bot
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The bot joins as a participant, transcribes the call and acts as a co-facilitator: it spots gaps in the use case and suggests follow-up questions. Let everyone in the call know it’s there.
        </p>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="How to invite the bot">
          <Chip active={mode === 'email'} onClick={() => setMode('email')}>
            <Mail className="size-3" /> Invite by email
          </Chip>
          <Chip active={mode === 'link'} onClick={() => setMode('link')}>
            <Video className="size-3" /> Paste a Meet link
          </Chip>
          <Chip active={mode === 'ics'} onClick={() => setMode('ics')}>
            <CalendarPlus className="size-3" /> Upload an invite (.ics)
          </Chip>
        </div>

        {mode === 'email' &&
          (address ? (
            <div className="space-y-3 text-sm">
              <p>Add this address as a guest on the calendar invite, for one call or a whole recurring series:</p>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]" data-testid="bot-invite-address">
                  {address}
                </code>
                <CopyButton text={address} label="Copy" />
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
                <li>The bot joins each call when it starts. Moving or cancelling the invite moves or cancels the bot.</li>
                <li>
                  This address files calls under {ontology.title}. The plain address <code className="font-mono">{bot!.inviteEmail}</code> works too: write <code className="font-mono">#{ontology.slug}</code> in the invite’s title or description.
                </li>
                <li>Upcoming calls show on this page. Switch the bot off for one, or have it post its prompts in the Meet chat.</li>
              </ul>
              {!bot!.calendarConnected && <p className="rounded-lg bg-warn-soft p-2.5 text-xs text-warn">The bot’s calendar isn’t connected on this server yet, so invites aren’t picked up. Upload the invite (.ics) instead for now.</p>}
              {bot!.lastSync && !bot!.lastSync.ok && <p className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger">Couldn’t read the bot’s calendar: {bot!.lastSync.error}</p>}
            </div>
          ) : (
            <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
              This server doesn’t have an email address for the bot yet. Paste the Meet link, or upload the calendar invite (.ics) to schedule the bot for a call or a recurring series.
            </p>
          ))}

        {mode === 'link' && (
          <>
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
            <Field label="Calendar invite" hint="In Google Calendar, open the event, then ⋮ › Download as .ics, or use the invite.ics attached to the invitation email. Recurring series are scheduled call by call.">
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
            {fileName && <p className="text-xs text-muted">{fileName}</p>}
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

function UpcomingCalls({ calls, onChange }: { calls: Meeting[]; onChange: () => void }) {
  const { id } = useOntology();
  const skip = useAction(async (m: Meeting, value: boolean) => {
    await api.updateMeeting(m.id, { skip: value });
    onChange();
  });
  if (!calls.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader icon={CalendarClock} title="Upcoming calls" subtitle="From calendar invites. The bot joins each one when it starts." />
      <ul className="divide-y divide-line">
        {calls.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <Link to={`/o/${id}/meetings/${m.id}`} className="min-w-0 flex-1 hover:underline">
              <div className="font-medium">{m.title}</div>
              <div className="flex items-center gap-1 text-xs text-muted">
                {formatDate(m.calendar?.start, true)}
                {m.calendar?.recurring && (
                  <>
                    {' '}
                    · <Repeat className="size-3" /> part of a series
                  </>
                )}
              </div>
            </Link>
            <Toggle checked={!m.calendar?.skip} onChange={(v) => void skip.run(m, !v)} label={m.calendar?.skip ? 'Skipping' : 'Bot will join'} disabled={skip.pending} />
          </li>
        ))}
      </ul>
      <div className="px-5 pb-3">
        <InlineError error={skip.error} />
      </div>
    </Card>
  );
}

export function MeetingsTab() {
  const { id, ontology } = useOntology();
  const { session, now } = useSession();
  const nav = useNavigate();
  const list = useAsync(() => api.meetings(id), [id]);
  const upcoming = (list.data ?? []).filter((m) => m.status === 'scheduled').sort((a, b) => (a.calendar?.start ?? '').localeCompare(b.calendar?.start ?? ''));
  const past = (list.data ?? []).filter((m) => m.status !== 'scheduled');
  const [dialog, setDialog] = useState<'upload' | 'bot'>();
  const simulate = useAction(async () => {
    const m = await api.simulateMeeting(id, 'Simulated working-group call');
    nav(`/o/${id}/meetings/${m.id}`);
  });

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Meetings</h2>
        <p className="max-w-2xl text-sm text-muted">Turn conversations into requirements. Concord extracts use cases, terms (with the speaker’s own words as evidence), competency questions, disagreements and decisions.</p>
      </div>
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <ActionCard icon={FileUp} title="Upload a transcript" body="From Google Meet, Gemini notes, Zoom (.vtt) or subtitles (.srt)." onClick={() => setDialog('upload')} cta="Upload" />
        <ActionCard
          icon={Video}
          title="Invite the co-lead bot"
          body={session?.meetBot.inviteEmail ? 'Add its email address to a calendar invite, or paste a Meet link. It listens and raises gaps and follow-up questions live.' : 'It joins your Google Meet, listens, and raises gaps and follow-up questions live.'}
          onClick={() => setDialog('bot')}
          cta="Invite to a Meet"
        />
        <ActionCard icon={Play} title="Run a simulated live meeting" body="Watch a scripted call unfold in real time, with the bot co-facilitating." onClick={() => void simulate.run()} cta="Start simulation" loading={simulate.pending} />
      </div>
      <InlineError error={simulate.error} />
      <UpcomingCalls calls={upcoming} onChange={() => void list.reload()} />
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !past.length ? (
        <EmptyState icon={Users} title={upcoming.length ? 'No past meetings yet' : 'No meetings yet'}>
          Upload a transcript, invite the bot to your next call, or run a simulated meeting to see how it works.
        </EmptyState>
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
                  {m.analysis && <span className="text-xs text-muted">{m.analysis.useCases.length} use cases · {m.analysis.terms.length} terms</span>}
                  <MeetingStatus m={m} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <UploadDialog open={dialog === 'upload'} onClose={() => setDialog(undefined)} />
      {dialog === 'bot' && <BotDialog open onClose={() => setDialog(undefined)} onScheduled={() => void list.reload()} bot={session?.meetBot} ontology={ontology} />}
    </div>
  );
}

function ActionCard({ icon: Icon, title, body, cta, onClick, loading }: { icon: typeof Bot; title: string; body: string; cta: string; onClick: () => void; loading?: boolean }) {
  return (
    <Card className="flex flex-col p-4">
      <Icon className="mb-2 size-5 text-accent" />
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-1 flex-1 text-xs text-muted">{body}</p>
      <div className="mt-3">
        <Button size="sm" onClick={onClick} loading={loading}>
          {cta}
        </Button>
      </div>
    </Card>
  );
}
