import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage } from '@concord/shared';
import { SendHorizontal } from 'lucide-react';
import { Markdown } from './Markdown';
import { MicButton } from './MicButton';
import { Avatar, Button, InlineError, cx } from './ui';
import { Logo } from './badges';
import { useDictation } from '../lib/speech';
import { scrollBehavior } from '../lib/motion';

export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 py-1" aria-label="Assistant is typing">
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
    </div>
  );
}

function Bubble({ m, userName, userAvatarUrl, plainText, children }: { m: ChatMessage; userName?: string; userAvatarUrl?: string; plainText?: boolean; children?: ReactNode }) {
  const mine = m.role === 'user';
  if (m.role === 'system') return <p className="py-1 text-center text-xs text-muted">{m.content}</p>;
  return (
    <div className={cx('flex gap-2.5', mine && 'flex-row-reverse')} data-testid={`chat-message-${m.role}`}>
      {mine ? (
        <Avatar name={userName ?? 'You'} src={userAvatarUrl} size={28} />
      ) : (
        <Logo className="size-7 shrink-0" />
      )}
      <div className={cx('max-w-[85%] min-w-0', mine && 'text-right')}>
        <div className={cx('inline-block rounded-2xl px-3.5 py-2.5 text-left', mine ? 'rounded-tr-sm bg-accent text-accent-fg' : 'rounded-tl-sm border border-line bg-surface')}>
          {mine || plainText ? <p className="text-sm whitespace-pre-wrap">{m.content}</p> : <Markdown text={m.content} />}
        </div>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}

export interface ChatViewProps {
  messages: ChatMessage[];
  pending?: boolean;
  onSend: (text: string, viaVoice: boolean) => void | Promise<void>;
  /** Rendered beneath the latest assistant message (quick replies). */
  quickReplies?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
  userName?: string;
  /** The signed-in person's picture, shown beside their messages. */
  userAvatarUrl?: string;
  voice?: boolean;
  bigMic?: boolean;
  error?: unknown;
  /** Shown just above the input, with the error (for example, messages that weren't sent and a way to retry them). */
  notice?: ReactNode;
  /** Show the assistant's messages as plain text rather than Markdown (for replies built from untrusted input). */
  plainText?: boolean;
  footer?: ReactNode;
  className?: string;
  /** Say under the box that Enter sends. Off where the page lists its keyboard shortcuts elsewhere. */
  keyHint?: boolean;
}

export function ChatView({ messages, pending, onSend, quickReplies, disabled, placeholder = 'Type your answer…', userName, userAvatarUrl, voice = true, bigMic, error, notice, footer, className, plainText, keyHint = true }: ChatViewProps) {
  const [text, setText] = useState('');
  const [voiceUsed, setVoiceUsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dict = useDictation((chunk) => {
    setVoiceUsed(true);
    setText((t) => (t ? `${t.replace(/\s+$/, '')} ${chunk}` : chunk));
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, [messages.length, pending]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text, dict.interim]);

  const send = async () => {
    const value = text.trim();
    if (!value || pending || disabled) return;
    if (dict.listening) dict.stop();
    setText('');
    const v = voiceUsed;
    setVoiceUsed(false);
    await onSend(value, v);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const shown = dict.listening && dict.interim ? `${text}${text ? ' ' : ''}${dict.interim}` : text;

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-4">
        {messages.map((m) => (
          <Bubble key={m.id} m={m} userName={userName} userAvatarUrl={userAvatarUrl} plainText={plainText}>
            {m === lastAssistant && !pending && quickReplies}
          </Bubble>
        ))}
        {pending && (
          <div className="flex gap-2.5">
            <Logo className="size-7 shrink-0" />
            <div className="rounded-2xl rounded-tl-sm border border-line bg-surface px-3.5 py-2.5">
              <TypingIndicator />
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-line pt-3">
        {error ? <div className="mb-2"><InlineError error={error} /></div> : null}
        {notice ? <div className="mb-2">{notice}</div> : null}
        {dict.error && <p className="mb-2 text-xs text-warn">{dict.error}</p>}
        <div className="flex items-end gap-2">
          {voice && dict.supported && <MicButton listening={dict.listening} transcribing={dict.transcribing} onClick={dict.toggle} size={bigMic ? 'lg' : 'md'} disabled={disabled} />}
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={taRef}
              rows={1}
              value={shown}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={dict.listening ? 'Listening… speak naturally' : placeholder}
              // A stable name: the placeholder changes while dictating, and would rename the box.
              aria-label={placeholder}
              className={cx(
                'block w-full resize-none rounded-xl border border-control bg-surface px-3.5 py-2.5 text-sm placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none disabled:opacity-60',
                dict.listening && 'border-danger/60',
              )}
            />
          </div>
          <Button variant="primary" icon={SendHorizontal} onClick={() => void send()} disabled={!text.trim() || pending || disabled} className="h-10" aria-label="Send">
            <span className="hidden sm:inline">Send</span>
          </Button>
        </div>
        {voice && dict.supported && (
          <p className="mt-1.5 text-xs text-subtle">
            {dict.listening ? 'Listening — tap the mic again to stop.' : dict.mode === 'recorder' ? 'Tap the mic to record; we transcribe when you stop.' : `Tip: tap the mic to speak instead of typing.${keyHint ? ' Enter sends, Shift+Enter for a new line.' : ''}`}
          </p>
        )}
        {footer}
      </div>
    </div>
  );
}
