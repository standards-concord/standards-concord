import { Eye } from 'lucide-react';
import { useSession } from '../lib/session';
import { cx } from './ui';

/**
 * Tells testers, before and after they send feedback, who can read it: the
 * deployment's administrators, both here and in the tester's own pod, where the
 * feedback folder is shared read-only with the administrators' WebIDs.
 */
export function FeedbackPrivacy({ className }: { className?: string }) {
  const { session } = useSession();
  const readers = session?.feedbackReaders ?? [];
  const pods = !!session?.solid.enabled;
  return (
    <div className={cx('flex items-start gap-2 text-xs text-muted', className)} data-testid="feedback-privacy">
      <Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p>
          <span className="font-medium text-fg">Who can read your feedback:</span> the Concord alpha team (this site’s administrators) can read everything you send, including your name and email if you give them. Other testers can’t.
          {pods
              ? readers.length
                ? ' When you’re signed in, we also save a copy in your Solid pod (in concord/feedback/) and share that folder read-only with the team’s WebID, so they can read it there too.'
                : ' When you’re signed in, we also save a copy in your Solid pod (in concord/feedback/).'
              : ' When you’re signed in, we also keep a copy in your private storage.'}
        </p>
        {pods && readers.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-accent">The team’s WebID{readers.length === 1 ? '' : 's'}</summary>
            <ul className="mt-1 space-y-0.5" data-testid="feedback-readers">
              {readers.map((w) => (
                <li key={w} className="truncate font-mono">
                  {w}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
