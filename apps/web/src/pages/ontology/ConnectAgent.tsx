import { Link } from 'react-router';
import { Bot } from 'lucide-react';
import { AgentHub } from '../Connect';
import { useOntology } from './Layout';

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

