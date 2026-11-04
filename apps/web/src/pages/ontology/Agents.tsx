import { Link } from 'react-router';
import type { AgentReport } from '@concord/shared';
import { Bot, Plug } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime, titleCase } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { ConnectAgent } from '../../components/ConnectAgent';
import { Badge, Card, CardHeader, EmptyState, ErrorCard, Loading } from '../../components/ui';
import { useOntology } from './Layout';

const REC: Record<NonNullable<NonNullable<AgentReport['analysis']>['recommendation']>, { label: string; tone: 'accent' | 'ok' | 'warn' | 'neutral' }> = {
  'change-ontology': { label: 'Change the ontology', tone: 'accent' },
  'use-existing-terms': { label: 'Use existing terms', tone: 'ok' },
  'local-extension': { label: 'Local extension', tone: 'neutral' },
  'needs-discussion': { label: 'Needs discussion', tone: 'warn' },
};

export function AgentsTab() {
  const { id, ontology } = useOntology();
  const { now } = useSession();
  const reports = useAsync(() => api.agentReports(id), [id]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Agents</h2>
        <p className="max-w-2xl text-sm text-muted">
          Let coding agents such as Claude Code or Codex read {ontology.title}, check their data against it, and report gaps — through an MCP connector. Reports are triaged by AI: often the ontology already has the right terms.
        </p>
      </div>
      <div className="grid gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader icon={Plug} title="Connect an agent" actions={<Link to="/connect" className="text-sm text-accent hover:underline">More ways to connect</Link>} />
            <div className="space-y-4 p-5">
              <ConnectAgent compact />
              <p className="text-xs text-muted">
                Then ask your agent, e.g. <em>“Use the concord MCP server to check whether our volunteer schema fits {ontology.title}, and report anything that’s missing.”</em>
              </p>
            </div>
          </Card>

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
                <EmptyState icon={Bot} title="No reports yet">
                  When a connected agent calls <code className="font-mono">report_gap</code>, its report and the AI’s recommendation appear here.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-line">
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
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-accent">Details</summary>
                      <div className="mt-2 space-y-2 text-sm">
                        <Markdown text={r.details} />
                        {r.context && <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs">{r.context}</pre>}
                      </div>
                    </details>
                    {r.analysis && (
                      <div className="mt-2 rounded-lg bg-surface-2 p-3 text-sm">
                        <Markdown text={r.analysis.summary} />
                        {r.analysis.existingTerms?.length ? <p className="mt-1 text-xs text-muted">Existing terms: {r.analysis.existingTerms.join(', ')}</p> : null}
                      </div>
                    )}
                    {r.changeRequestId && (
                      <Link to={`/o/${id}/changes/${r.changeRequestId}`} className="mt-2 inline-block text-sm text-accent hover:underline">
                        View the change request →
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
