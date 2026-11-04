import { Link } from 'react-router';
import type { AppCheckResult, ChangeRequestDetail, Review, Vote } from '@concord/shared';
import { AppWindow, Bot, CheckCircle2, CircleAlert, ExternalLink, XCircle } from 'lucide-react';
import { useSession } from '../lib/session';
import { relativeTime } from '../lib/format';
import { Badge, Card, CardHeader } from './ui';

const OUTCOME = {
  passed: { label: 'Passed', tone: 'ok', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  error: { label: "Couldn't run", tone: 'warn', icon: CircleAlert },
} as const;

/**
 * Small badge for reviews and votes that autopilot made, saying when one no longer counts:
 * autopilot withdrew it, or it was made for an earlier version of the change or working draft.
 */
export function AutopilotBadge({ say, revision }: { say: Review | Vote; revision?: string }) {
  const mark = say.autopilot;
  if (!mark) return null;
  const yes = 'decision' in say ? say.decision === 'approve' : say.choice === 'yes';
  const apps = mark.apps.map((a) => a.name).join(', ');
  const lapsed = say.withdrawnAt
    ? { label: 'Withdrawn', title: 'Autopilot took this back, so it no longer counts.' }
    : revision && mark.revision !== revision
      ? { label: 'No longer counts', title: 'Made for an earlier version of the change or the working draft. It counts again once the app passes the current one.' }
      : undefined;
  return (
    <>
      <Badge tone={lapsed ? 'outline' : 'accent'} icon={Bot} title={`Made by autopilot because ${apps} ${yes ? 'passed' : 'failed'}`}>
        Autopilot
      </Badge>
      {lapsed && (
        <Badge tone="outline" title={lapsed.title}>
          {lapsed.label}
        </Badge>
      )}
    </>
  );
}

function Row({ c }: { c: AppCheckResult }) {
  const { now } = useSession();
  const o = OUTCOME[c.outcome];
  return (
    <li className="px-5 py-3 text-sm" data-testid="app-check">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.app.name}</span>
        <Badge tone={c.current ? o.tone : 'outline'} icon={o.icon}>
          {o.label}
        </Badge>
        {!c.current && <span className="text-xs text-muted">out of date (the change, the working draft or the app has moved on), waiting for a new run</span>}
        {c.app.autopilot && <Badge tone="outline">Autopilot on</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {c.app.owner?.name ?? 'Someone'}’s app{c.app.repo ? ` (${c.app.repo})` : ''} · {relativeTime(c.at, now())}
        {c.runUrl && (
          <>
            {' · '}
            <a className="inline-flex items-center gap-0.5 text-accent hover:underline" href={c.runUrl} target="_blank" rel="noreferrer">
              CI run <ExternalLink className="size-3" />
            </a>
          </>
        )}
      </p>
      {c.summary && c.outcome !== 'passed' && <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">{c.summary}</pre>}
    </li>
  );
}

/** What connected apps found when they tested this change. */
export function AppChecksCard({ cr, ontologyId }: { cr: ChangeRequestDetail; ontologyId: string }) {
  const checks = cr.appChecks ?? [];
  const current = checks.filter((c) => c.current);
  const failed = current.filter((c) => c.outcome === 'failed').length;
  const passed = current.filter((c) => c.outcome === 'passed').length;
  const open = ['review', 'voting'].includes(cr.status);
  if (!checks.length && !open) return null;
  return (
    <Card as="section">
      <CardHeader
        icon={AppWindow}
        title="App checks"
        subtitle={checks.length ? `${passed} passed, ${failed} failed against this version of the change` : 'Apps built on this ontology, tested against this change'}
        actions={
          <Link to={`/o/${ontologyId}/apps`} className="text-xs font-medium text-accent hover:underline">
            Connect your app
          </Link>
        }
      />
      {checks.length ? (
        <ul className="divide-y divide-line">
          {checks.map((c) => (
            <Row key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-muted">No app has tested this change yet. Connected apps test every open change on their next CI run.</p>
      )}
    </Card>
  );
}
