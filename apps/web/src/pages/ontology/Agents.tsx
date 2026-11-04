import { Link, useSearchParams } from 'react-router';
import type { AgentReport } from '@concord/shared';
import { Bot, Plug } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime, titleCase } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { ConnectAgent } from '../../components/ConnectAgent';
import { Badge, Button, Card, CardHeader, cx, EmptyState, ErrorCard, Loading } from '../../components/ui';
import { useOntology } from './Layout';

const REC: Record<NonNullable<NonNullable<AgentReport['analysis']>['recommendation']>, { label: string; tone: 'accent' | 'ok' | 'warn' | 'neutral' }> = {
  'change-ontology': { label: 'Change the ontology', tone: 'accent' },
  'use-existing-terms': { label: 'Use existing terms', tone: 'ok' },
  'local-extension': { label: 'Local extension', tone: 'neutral' },
  'needs-discussion': { label: 'Needs discussion', tone: 'warn' },
};

type View = 'reports' | 'connect';

export function AgentsTab() {
  const { id, ontology } = useOntology();
  const { now } = useSession();
  const reports = useAsync(() => api.agentReports(id), [id]);
  const [params, setParams] = useSearchParams();
  const asked = params.get('view');
  // Reports first when there are some; otherwise how to connect one.
  const view: View = asked === 'reports' || asked === 'connect' ? asked : reports.data && !reports.data.length ? 'connect' : 'reports';
  const show = (v: View) => setParams((p) => (p.set('view', v), p), { replace: true });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Agents</h2>
        <p className="max-w-2xl text-sm text-muted">
          Coding agents such as Claude Code or Codex can read {ontology.title}, check their data against it and report gaps through Concord’s MCP connector. Reports are triaged by AI: often the ontology already has the right terms.
        </p>
      </div>

      <div role="tablist" aria-label="Agents" className="inline-flex rounded-lg border border-line-strong p-0.5 text-sm">
        {(
          [
            ['reports', `Reports${reports.data?.length ? ` (${reports.data.length})` : ''}`],
            ['connect', 'Connect an agent'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => show(v)} className={cx('rounded-md px-3 py-1', view === v ? 'bg-surface-2 font-medium' : 'text-muted hover:text-fg')}>
            {label}
          </button>
        ))}
      </div>

      {view === 'connect' ? (
        <Card>
          <CardHeader icon={Plug} title="Connect an agent" actions={<Link to="/connect" className="text-sm text-accent hover:underline">Open the full setup page</Link>} />
          <div className="space-y-4 p-5">
            <ConnectAgent />
            <p className="text-xs text-muted">
              Then ask your agent, e.g. <em>“Use the concord MCP server to check whether our volunteer schema fits {ontology.title}, and report anything that’s missing.”</em>
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader icon={Bot} title="Agent reports" subtitle="Gaps and problems agents have reported, with AI triage" />
          {reports.error && !reports.data ? (
            <div className="p-5">
              <ErrorCard error={reports.error} onRetry={reports.reload} />
            </div>
          ) : !reports.data ? (
            <Loading />
          ) : !reports.data.length ? (
            <div className="p-5">
              <EmptyState icon={Bot} title="No reports yet" action={<Button onClick={() => show('connect')}>Connect an agent</Button>}>
                When a connected agent reports a gap, it appears here with the AI’s recommendation.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-line" data-testid="agent-reports">
              {reports.data.map((r) => (
                <li key={r.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.summary}</span>
                    <Badge tone="outline">{titleCase(r.kind)}</Badge>
                    {r.analysis?.recommendation && <Badge tone={REC[r.analysis.recommendation].tone}>{REC[r.analysis.recommendation].label}</Badge>}
                    <Badge>{titleCase(r.status)}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {r.agentName} · {relativeTime(r.createdAt, now())}
                    {r.changeRequestId && (
                      <>
                        {' · '}
                        <Link to={`/o/${id}/changes/${r.changeRequestId}`} className="text-accent hover:underline">
                          View the change request →
                        </Link>
                      </>
                    )}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent">Details and AI analysis</summary>
                    <div className="mt-2 space-y-3 text-sm">
                      <Markdown text={r.details} />
                      {r.context && <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs">{r.context}</pre>}
                      {r.analysis && (
                        <div className="rounded-lg bg-surface-2 p-3">
                          <Markdown text={r.analysis.summary} />
                          {r.analysis.existingTerms?.length ? <p className="mt-1 text-xs text-muted">Existing terms: {r.analysis.existingTerms.join(', ')}</p> : null}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
