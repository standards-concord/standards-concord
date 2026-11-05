import { Link, Navigate, useSearchParams } from 'react-router';
import type { AgentReport } from '@concord/shared';
import { Bot, Plug } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime, titleCase } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { AgentHub } from '../Connect';
import { Badge, Card, cx, EmptyState, ErrorCard, Loading } from '../../components/ui';
import { useOntology } from './Layout';

const REC: Record<NonNullable<NonNullable<AgentReport['analysis']>['recommendation']>, { label: string; tone: 'accent' | 'ok' | 'warn' | 'neutral' }> = {
  'change-ontology': { label: 'Change the ontology', tone: 'accent' },
  'use-existing-terms': { label: 'Use existing terms', tone: 'ok' },
  'local-extension': { label: 'Local extension', tone: 'neutral' },
  'needs-discussion': { label: 'Needs discussion', tone: 'warn' },
};

/** Explore → Connect an agent: the same agent hub as the account menu's page (setup, connected agents, tokens), inside this ontology. */
export function ConnectAgentTab() {
  const { id, ontology } = useOntology();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Connect an agent</h2>
          <p className="max-w-2xl text-sm text-muted">
            Let Claude, ChatGPT, Claude Code, Codex or your editor read {ontology.title}, query it, check your data against it and report what’s missing, through Concord’s MCP connector.
          </p>
        </div>
        <Link to={`/o/${id}/agents`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
          <Bot className="size-4" aria-hidden /> See agent reports
        </Link>
      </div>
      <AgentHub
        example={
          <p className="text-xs text-muted">
            Then ask your agent, e.g. <em>“Use the concord MCP server to check whether our volunteer schema fits {ontology.title}, and report anything that’s missing.”</em>
          </p>
        }
      />
    </div>
  );
}

/** Requirements → Agent reports: gaps and problems connected agents have reported, with AI triage. */
export function AgentReportsTab() {
  const { id, ontology } = useOntology();
  const { now } = useSession();
  const reports = useAsync(() => api.agentReports(id), [id]);
  const [params] = useSearchParams();
  // Old links to the setup view of this page.
  if (params.get('view') === 'connect') return <Navigate to={`/o/${id}/connect`} replace />;
  const connect = (
    <Link to={`/o/${id}/connect`} className={cx('inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-surface-2')}>
      <Plug className="size-4" aria-hidden /> Connect an agent
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Agent reports</h2>
          <p className="max-w-2xl text-sm text-muted">
            Gaps and problems that coding agents found while working with {ontology.title}. Each is triaged by AI: often the ontology already has the right terms.
          </p>
        </div>
        {connect}
      </div>

      <Card>
        {reports.error && !reports.data ? (
          <div className="p-5">
            <ErrorCard error={reports.error} onRetry={reports.reload} />
          </div>
        ) : !reports.data ? (
          <Loading />
        ) : !reports.data.length ? (
          <div className="p-5">
            <EmptyState icon={Bot} title="No reports yet" action={connect}>
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
    </div>
  );
}
