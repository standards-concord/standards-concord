import { Link } from 'react-router';
import { Bot } from 'lucide-react';
import { Page } from '../components/Shell';
import { ConnectAgent } from '../components/ConnectAgent';
import { Card, PageHeader } from '../components/ui';
import { useSession } from '../lib/session';

/** Public page: connect a coding agent or Claude to Concord over MCP. */
export function ConnectPage() {
  const { session } = useSession();
  return (
    <Page>
      <PageHeader
        eyebrow="Agents"
        title="Connect your agent to Concord"
        subtitle="Let Claude, ChatGPT, Claude Code, Codex or your editor read Concord’s ontologies, check data against them and report what’s missing."
      />
      <Card className="p-5">
        <ConnectAgent />
      </Card>
      <p className="mt-4 flex items-center gap-2 text-sm text-muted">
        <Bot className="size-4" />
        {session?.user ? (
          <span>
            Manage connected agents in <Link to="/settings#agents" className="text-accent hover:underline">Settings</Link>.
          </span>
        ) : (
          <span>You’ll sign in to Concord when your agent first connects.</span>
        )}
      </p>
    </Page>
  );
}
