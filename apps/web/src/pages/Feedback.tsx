import { useState } from 'react';
import { Link } from 'react-router';
import type { ChatMessage, FeedbackQuestion, FeedbackSubmission } from '@concord/shared';
import { ArrowLeft, Heart, ListChecks, MessageCircle, Mic, Send } from 'lucide-react';
import { api, type FeedbackAnswers } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useWalkthrough } from '../lib/walkthrough';
import { dictationSupport } from '../lib/speech';
import { Page } from '../components/Shell';
import { ChatView } from '../components/ChatView';
import { Button, Card, Chip, ErrorCard, Field, InlineError, Input, Select, Textarea, cx } from '../components/ui';

type Pathway = FeedbackSubmission['pathway'];

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, content, at: new Date().toISOString() });

function formatAnswer(v: FeedbackAnswers[string] | undefined) {
  if (v === undefined || v === '') return '';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function QuickReplies({ q, onPick, current }: { q: FeedbackQuestion; onPick: (text: string, value: string | number | string[]) => void; current?: FeedbackAnswers[string] }) {
  const [multi, setMulti] = useState<string[]>(Array.isArray(current) ? current : []);
  if (q.type === 'scale') {
    const min = q.min ?? 1;
    const max = q.max ?? 5;
    const nums = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    return (
      <div>
        <div className="flex flex-wrap gap-1.5">
          {nums.map((n) => (
            <button
              key={n}
              onClick={() => onPick(String(n), n)}
              className={cx('size-9 rounded-lg border text-sm font-medium transition-colors', current === n ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface hover:border-accent')}
            >
              {n}
            </button>
          ))}
        </div>
        {(q.minLabel || q.maxLabel) && (
          <div className="mt-1 flex justify-between gap-4 text-[0.7rem] text-muted" style={{ maxWidth: nums.length * 42 }}>
            <span>{q.minLabel}</span>
            <span>{q.maxLabel}</span>
          </div>
        )}
      </div>
    );
  }
  if (q.type === 'choice')
    return (
      <div className="flex flex-wrap gap-1.5">
        {(q.options ?? []).map((o) => (
          <Chip key={o} active={current === o} onClick={() => onPick(o, o)}>
            {o}
          </Chip>
        ))}
        {q.optional && (
          <Chip onClick={() => onPick('Skip', '')}>Skip</Chip>
        )}
      </div>
    );
  if (q.type === 'multi')
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {(q.options ?? []).map((o) => (
            <Chip key={o} active={multi.includes(o)} onClick={() => setMulti((m) => (m.includes(o) ? m.filter((x) => x !== o) : [...m, o]))}>
              {o}
            </Chip>
          ))}
        </div>
        <Button size="sm" variant="primary" icon={Send} disabled={!multi.length} onClick={() => onPick(multi.join(', '), multi)}>
          Send {multi.length ? `(${multi.length})` : ''}
        </Button>
      </div>
    );
  return null;
}

function AnswerEditor({ q, value, onChange }: { q: FeedbackQuestion; value: FeedbackAnswers[string] | undefined; onChange: (v: FeedbackAnswers[string]) => void }) {
  if (q.type === 'scale') {
    const min = q.min ?? 1;
    const max = q.max ?? 5;
    return (
      <Select aria-label={q.text} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} className="h-8 text-xs">
        <option value="">—</option>
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    );
  }
  if (q.type === 'choice')
    return (
      <Select aria-label={q.text} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs">
        <option value="">—</option>
        {(q.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  if (q.type === 'multi') {
    const arr = Array.isArray(value) ? value : value ? [String(value)] : [];
    return (
      <div className="flex flex-wrap gap-1" role="group" aria-label={q.text}>
        {(q.options ?? []).map((o) => (
          <Chip key={o} active={arr.includes(o)} onClick={() => onChange(arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o])} className="py-0.5 text-[0.7rem]">
            {o}
          </Chip>
        ))}
      </div>
    );
  }
  return <Textarea aria-label={q.text} rows={2} value={formatAnswer(value)} onChange={(e) => onChange(e.target.value)} className="min-h-0 text-xs" />;
}

export function FeedbackPage() {
  const { session } = useSession();
  const w = useWalkthrough();
  const questions = useAsync(() => api.feedbackQuestions(), []);
  const [pathway, setPathway] = useState<Pathway>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answers, setAnswers] = useState<FeedbackAnswers>({});
  const [done, setDone] = useState(false);
  const [nextQ, setNextQ] = useState<string>();
  const [usedVoice, setUsedVoice] = useState(false);
  const [pending, setPending] = useState(false);
  const [chatError, setChatError] = useState<unknown>();
  const [name, setName] = useState(session?.user?.simulated ? '' : (session?.user?.name ?? ''));
  const [email, setEmail] = useState(session?.user?.simulated ? '' : (session?.user?.email ?? ''));
  const [submitted, setSubmitted] = useState<FeedbackSubmission>();
  const voice = dictationSupport() !== 'none';

  const turn = async (p: Pathway, msgs: ChatMessage[], ans: FeedbackAnswers) => {
    setPending(true);
    setChatError(undefined);
    try {
      const r = await api.feedbackChat({ pathway: p, messages: msgs, answers: ans });
      setMessages([...msgs, msg('assistant', r.reply)]);
      if (r.answers) setAnswers({ ...ans, ...r.answers });
      setDone(r.done);
      setNextQ(r.nextQuestionId);
    } catch (e) {
      setChatError(e);
    } finally {
      setPending(false);
    }
  };

  const start = (p: Pathway) => {
    setPathway(p);
    setMessages([]);
    setAnswers({});
    setDone(false);
    void turn(p, [], {});
  };

  const send = (text: string, viaVoice: boolean, value?: { qid: string; v: FeedbackAnswers[string] }) => {
    if (!pathway) return;
    if (viaVoice) setUsedVoice(true);
    const nextMsgs = [...messages, msg('user', text)];
    const nextAns = value ? { ...answers, [value.qid]: value.v } : answers;
    setMessages(nextMsgs);
    setAnswers(nextAns);
    void turn(pathway, nextMsgs, nextAns);
  };

  const submit = useAction(async () => {
    const s = await api.submitFeedback({
      userId: session?.user?.id,
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      role: w.myRoles[0],
      pathway: pathway!,
      answers,
      transcript: messages,
      usedVoice,
    });
    setSubmitted(s);
  });

  if (submitted)
    return (
      <Page>
        <Card className="mx-auto max-w-lg p-8 text-center">
          <Heart className="mx-auto size-8 text-accent" />
          <h1 className="mt-3 text-xl font-semibold">Thank you!</h1>
          <p className="mt-2 text-sm text-muted">Your feedback goes straight to the Open Data Institute team building Concord. It genuinely shapes what we build next.</p>
          <div className="mt-6 flex justify-center gap-2">
            <Link to="/">
              <Button>Back to the hub</Button>
            </Link>
            <Button variant="ghost" onClick={() => { setSubmitted(undefined); setPathway(undefined); setMessages([]); setAnswers({}); }}>
              Tell us something else
            </Button>
          </div>
        </Card>
      </Page>
    );

  if (!pathway)
    return (
      <Page>
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Tell us what you think</h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted">
            This is an early prototype, and your honest reactions matter more than polish. Type, or tap the microphone and just talk — whatever’s easier.
          </p>
        </div>
        <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-2">
          <button onClick={() => start('structured')} className="group text-left">
            <Card className="h-full p-6 transition-shadow group-hover:border-accent group-hover:shadow-md">
              <ListChecks className="size-6 text-accent" />
              <h2 className="mt-3 font-semibold">Guided feedback</h2>
              <p className="text-xs text-muted">About 8 minutes</p>
              <p className="mt-2 text-sm text-muted">A friendly assistant walks you through a short set of questions about each part of Concord.</p>
            </Card>
          </button>
          <button onClick={() => start('general')} className="group text-left">
            <Card className="h-full p-6 transition-shadow group-hover:border-accent group-hover:shadow-md">
              <MessageCircle className="size-6 text-accent" />
              <h2 className="mt-3 font-semibold">Just tell us something</h2>
              <p className="text-xs text-muted">As long or short as you like</p>
              <p className="mt-2 text-sm text-muted">A bug, an idea, something confusing, something you loved. The assistant may ask a follow-up or two.</p>
            </Card>
          </button>
        </div>
        {voice && (
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted">
            <Mic className="size-3.5" /> Voice input works in this browser.
          </p>
        )}
        {questions.error ? <ErrorCard className="mx-auto mt-6 max-w-3xl" error={questions.error} onRetry={questions.reload} /> : null}
      </Page>
    );

  const qs = questions.data ?? [];
  const current = qs.find((q) => q.id === nextQ);
  const captured = qs.filter((q) => pathway === 'structured' || answers[q.id] !== undefined);
  const answeredCount = qs.filter((q) => formatAnswer(answers[q.id]) !== '').length;

  return (
    <Page wide>
      <button onClick={() => setPathway(undefined)} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Choose a different way
      </button>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="flex h-[calc(100vh-13rem)] min-h-[520px] flex-col p-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div>
              <h1 className="font-semibold">{pathway === 'structured' ? 'Guided feedback' : 'Tell us something'}</h1>
              {pathway === 'structured' && qs.length > 0 && <p className="text-xs text-muted">{answeredCount} of {qs.length} questions answered</p>}
            </div>
            {current && <span className="text-xs text-muted">{current.section}</span>}
          </div>
          <ChatView
            className="min-h-0 flex-1"
            messages={messages}
            pending={pending}
            bigMic
            error={chatError}
            userName={name || session?.user?.name}
            userAvatarUrl={session?.user?.avatarUrl}
            onSend={(t, v) => send(t, v)}
            placeholder={done ? 'Anything else? Or submit when ready.' : 'Type or tap the mic and talk…'}
            quickReplies={current && current.type !== 'text' ? <QuickReplies key={current.id} q={current} current={answers[current.id]} onPick={(text, v) => send(text, false, { qid: current.id, v })} /> : undefined}
          />
          {done && (
            <div className="mt-3 rounded-lg bg-ok-soft p-3 text-sm">
              That’s everything — review your answers on the right, then submit.{' '}
              <Button size="sm" variant="primary" className="ml-2" loading={submit.pending} onClick={() => void submit.run()}>
                Submit feedback
              </Button>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold">Your answers so far</h2>
            <p className="mb-4 text-xs text-muted">Captured from the conversation. You can edit anything.</p>
            {questions.error ? <ErrorCard error={questions.error} onRetry={questions.reload} /> : null}
            <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              {captured.map((q) => (
                <div key={q.id} className={cx('rounded-lg border p-2.5', q.id === nextQ ? 'border-accent' : 'border-line')}>
                  <div className="mb-1.5 text-xs font-medium">{q.text}</div>
                  <AnswerEditor q={q} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
                </div>
              ))}
              {!captured.length && <p className="text-xs text-subtle">Nothing captured yet.</p>}
              {Object.keys(answers)
                .filter((k) => !qs.some((q) => q.id === k))
                .map((k) => (
                  <div key={k} className="rounded-lg border border-line p-2.5">
                    <div className="mb-1 text-xs font-medium">{k}</div>
                    <Textarea rows={2} className="min-h-0 text-xs" value={formatAnswer(answers[k])} onChange={(e) => setAnswers((a) => ({ ...a, [k]: e.target.value }))} />
                  </div>
                ))}
            </div>
          </Card>
          <Card className="space-y-3 p-5">
            <Field label="Name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email (optional)" hint="Only if you’re happy for us to follow up.">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Button variant={done ? 'primary' : 'secondary'} className="w-full" icon={Send} loading={submit.pending} disabled={!messages.some((m) => m.role === 'user')} onClick={() => void submit.run()}>
              {done ? 'Submit feedback' : 'Submit what I’ve said so far'}
            </Button>
            <InlineError error={submit.error} />
            {usedVoice && <p className="text-xs text-muted">Thanks for using voice — it helps us test it.</p>}
          </Card>
        </div>
      </div>
    </Page>
  );
}
