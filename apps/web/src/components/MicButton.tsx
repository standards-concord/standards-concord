import { Mic, MicOff, LoaderCircle } from 'lucide-react';
import { cx } from './ui';

export function MicButton({ listening, transcribing, onClick, size = 'md', disabled }: { listening: boolean; transcribing?: boolean; onClick: () => void; size?: 'md' | 'lg'; disabled?: boolean }) {
  const dims = size === 'lg' ? 'size-12' : 'size-9';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || transcribing}
      title={listening ? 'Stop dictation' : 'Speak your answer'}
      aria-label={listening ? 'Stop dictation' : 'Start voice input'}
      aria-pressed={listening}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50',
        dims,
        listening ? 'mic-live border-danger bg-danger text-danger-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
      )}
    >
      {transcribing ? <LoaderCircle className="size-4 animate-spin" /> : listening ? <MicOff className="size-4" /> : <Mic className={size === 'lg' ? 'size-5' : 'size-4'} />}
    </button>
  );
}
