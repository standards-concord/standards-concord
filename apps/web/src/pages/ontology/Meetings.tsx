import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Meeting } from '@concord/shared';
import { Bot, FileUp, Play, Radio, Users, Video } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime, titleCase } from '../../lib/format';
import { Badge, Button, Card, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Textarea } from '../../components/ui';
import { useOntology } from './Layout';

export function MeetingStatus({ m }: { m: Meeting }) {
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

function BotDialog({ open, onClose, provider }: { open: boolean; onClose: () => void; provider?: string }) {
  const { id } = useOntology();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const valid = /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(url.trim());
  const invite = useAction(async () => {
    const m = await api.inviteBot(id, title.trim() || 'Google Meet call', url.trim());
    onClose();
    nav(`/o/${id}/meetings/${m.id}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite the co-lead bot to a Google Meet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Bot} loading={invite.pending} disabled={!valid} onClick={() => void invite.run()}>
            Send the bot
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The bot joins as a participant, transcribes the call and acts as a co-facilitator: it spots gaps in the use case and suggests follow-up questions in the chat.
          Let everyone in the call know it’s there.
        </p>
        <Field label="Meet link">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" inputMode="url" />
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Use case workshop" />
        </Field>
        {provider === 'simulated' && <p className="rounded-lg bg-warn-soft p-2.5 text-xs text-warn">This server uses a simulated bot, so it won’t actually join your call — it replays a scripted conversation instead.</p>}
        <InlineError error={invite.error} />
      </div>
    </Dialog>
  );
}

export function MeetingsTab() {
  const { id } = useOntology();
  const { session, now } = useSession();
  const nav = useNavigate();
  const list = useAsync(() => api.meetings(id), [id]);
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
        <ActionCard icon={Video} title="Invite the co-lead bot" body="It joins your Google Meet, listens, and raises gaps and follow-up questions live." onClick={() => setDialog('bot')} cta="Invite to a Meet" />
        <ActionCard icon={Play} title="Run a simulated live meeting" body="Watch a scripted call unfold in real time, with the bot co-facilitating." onClick={() => void simulate.run()} cta="Start simulation" loading={simulate.pending} />
      </div>
      <InlineError error={simulate.error} />
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState icon={Users} title="No meetings yet">
          Upload a transcript, invite the bot to your next call, or run a simulated meeting to see how it works.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {list.data.map((m) => (
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
      <BotDialog open={dialog === 'bot'} onClose={() => setDialog(undefined)} provider={session?.meetBot.provider} />
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
