import { useState } from 'react';
import { Link } from 'react-router';
import type { AgentReport, AgentToken } from '@concord/shared';
import { Bot, KeyRound, Plug, Terminal, Wrench } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime, titleCase } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Card, CardHeader, CodeBlock, CopyButton, EmptyState, ErrorCard, InlineError, Input, Loading, cx } from '../../components/ui';
import { useOntology } from './Layout';

const TOOLS: [string, string][] = [
  ['list_ontologies', 'List ontologies on the hub'],
  ['get_ontology', 'Fetch an ontology (metadata, classes, properties) in a chosen format'],
  ['search_terms', 'Find terms by label, synonym or definition'],
  ['get_term', 'Get a term’s definition, axioms and usage'],
  ['sparql_query', 'Run a read-only SPARQL query against the working draft or a release'],
  ['validate_data', 'Validate instance data (Turtle/JSON-LD) against the ontology and SHACL shapes'],
  ['report_gap', 'Report a missing concept or something that doesn’t fit — AI triage decides what to do'],
  ['propose_change', 'Propose structured changes as a draft change request'],
  ['get_change_request', 'Check the status of a change request'],
];

const REC: Record<NonNullable<NonNullable<AgentReport['analysis']>['recommendation']>, { label: string; tone: 'accent' | 'ok' | 'warn' | 'neutral' }> = {
  'change-ontology': { label: 'Change the ontology', tone: 'accent' },
  'use-existing-terms': { label: 'Use existing terms', tone: 'ok' },
  'local-extension': { label: 'Local extension', tone: 'neutral' },
  'needs-discussion': { label: 'Needs discussion', tone: 'warn' },
};

export function TokenCreator({ onCreated }: { onCreated?: (t: AgentToken) => void }) {
  const [name, setName] = useState('My coding agent');
  const [created, setCreated] = useState<AgentToken>();
  const create = useAction(async () => {
    const t = await api.createAgentToken(name.trim() || 'Agent');
    setCreated(t);
    onCreated?.(t);
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" aria-label="Token name" />
        <Button variant="primary" icon={KeyRound} loading={create.pending} onClick={() => void create.run()}>
          Create token
        </Button>
      </div>
      <InlineError error={create.error} />
      {created?.token && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft p-3">
          <p className="mb-2 text-sm font-medium">Copy your token now — it won’t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1.5 font-mono text-xs">{created.token}</code>
            <CopyButton text={created.token} label="Copy" />
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentsTab() {
  const { id, ontology } = useOntology();
  const { now } = useSession();
  const reports = useAsync(() => api.agentReports(id), [id]);
  const [token, setToken] = useState<string>();
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const mcpUrl = `${origin}/mcp`;
  const tok = token ?? '<token>';
  const claudeCmd = `claude mcp add --transport http concord ${mcpUrl} --header "Authorization: Bearer ${tok}"`;
  const codexEnv = `# ~/.codex/config.toml
[mcp_servers.concord]
url = "${mcpUrl}"
bearer_token_env_var = "CONCORD_TOKEN"

# then, in your shell:
# export CONCORD_TOKEN=${tok}`;
  const codexHeaders = `# ~/.codex/config.toml (alternative: inline header)
[mcp_servers.concord]
url = "${mcpUrl}"
http_headers = { "Authorization" = "Bearer ${tok}" }`;
  const [codexMode, setCodexMode] = useState<'env' | 'headers'>('env');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Agents</h2>
        <p className="max-w-2xl text-sm text-muted">
          Let coding agents such as Claude Code or Codex read {ontology.title}, check their data against it, and report gaps — through an MCP connector. Reports are triaged by AI: often the ontology already has the right terms.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader icon={Plug} title="Connect an agent" />
            <div className="space-y-5 p-5">
              <div>
                <div className="mb-1 text-sm font-medium">1. MCP server URL</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{mcpUrl}</code>
                  <CopyButton text={mcpUrl} label="Copy" />
                </div>
                <p className="mt-1 text-xs text-muted">Streamable HTTP transport, authenticated with a bearer token.</p>
              </div>
              <div>
                <div className="mb-2 text-sm font-medium">2. Create a token</div>
                <TokenCreator onCreated={(t) => setToken(t.token)} />
              </div>
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Terminal className="size-4" /> 3a. Claude Code
                </div>
                <CodeBlock code={claudeCmd} />
              </div>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Terminal className="size-4" /> 3b. Codex
                  </span>
                  <div className="inline-flex rounded-lg border border-line-strong p-0.5 text-xs">
                    <button onClick={() => setCodexMode('env')} className={cx('rounded-md px-2 py-0.5', codexMode === 'env' ? 'bg-surface-2 font-medium' : 'text-muted')}>
                      Env var
                    </button>
                    <button onClick={() => setCodexMode('headers')} className={cx('rounded-md px-2 py-0.5', codexMode === 'headers' ? 'bg-surface-2 font-medium' : 'text-muted')}>
                      Inline header
                    </button>
                  </div>
                </div>
                <CodeBlock code={codexMode === 'env' ? codexEnv : codexHeaders} />
              </div>
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
        <Card className="h-fit">
          <CardHeader icon={Wrench} title="MCP tools" />
          <ul className="divide-y divide-line">
            {TOOLS.map(([n, d]) => (
              <li key={n} className="px-5 py-2.5">
                <code className="font-mono text-xs font-semibold">{n}</code>
                <p className="text-xs text-muted">{d}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
