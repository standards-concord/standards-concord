import { Link } from 'react-router';
import type { ActivityItem } from '@concord/shared';
import { Activity, Bot } from 'lucide-react';
import { api } from '../api';
import { useAsync } from '../lib/hooks';
import { relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Avatar, EmptyState, ErrorCard, Loading, cx } from './ui';

export function ActivityList({ items, compact }: { items: ActivityItem[]; compact?: boolean }) {
  const { now } = useSession();
  if (!items.length) return <p className="py-6 text-center text-sm text-muted">No activity yet.</p>;
  return (
    <ol className="space-y-0.5">
      {items.map((a) => {
        const body = (
          <div className={cx('flex gap-3 rounded-lg px-2 py-2', a.link && 'hover:bg-surface-2')}>
            {a.actorName ? <Avatar name={a.actorName} src={a.actorAvatarUrl} size={compact ? 22 : 26} simulated={a.simulated} /> : <span className="mt-0.5 rounded-full bg-surface-2 p-1"><Bot className="size-3.5 text-muted" /></span>}
            <div className="min-w-0 flex-1 text-sm">
              <p className="leading-snug">
                {a.actorName && <span className="font-medium">{a.actorName} </span>}
                <span className="text-fg/85">{a.message}</span>
                {a.simulated && <span className="ml-1.5 rounded bg-surface-2 px-1 py-px text-[0.65rem] text-muted">simulated</span>}
              </p>
              <p className="mt-0.5 text-xs text-subtle">{relativeTime(a.at, now())}</p>
            </div>
          </div>
        );
        return <li key={a.id}>{a.link ? <Link to={a.link}>{body}</Link> : body}</li>;
      })}
    </ol>
  );
}

export function ActivityFeed({ ontologyId, limit = 12, compact, refreshKey }: { ontologyId?: string; limit?: number; compact?: boolean; refreshKey?: unknown }) {
  const state = useAsync(() => api.activity(ontologyId), [ontologyId, refreshKey]);
  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  if (!state.data.length)
    return (
      <EmptyState icon={Activity} title="Nothing has happened yet">
        Activity from people, agents and the governance process will show up here.
      </EmptyState>
    );
  return <ActivityList items={state.data.slice(0, limit)} compact={compact} />;
}
