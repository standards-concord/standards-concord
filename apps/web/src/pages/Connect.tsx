import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Bot } from 'lucide-react';
import { Page } from '../components/Shell';
import { ConnectAgent } from '../components/ConnectAgent';
import { ConnectedAgents, PersonalTokens } from '../components/AgentAccess';
import { Card, PageHeader } from '../components/ui';
import { useSession } from '../lib/session';

/** Scrolls to #agents or #tokens when the page opens with that hash, or when a link to it is followed. */
function useHashScroll(ids: string[], ready: boolean) {
  const { hash, key } = useLocation();
  useEffect(() => {
    const target = hash.slice(1);
    if (!ready || !ids.includes(target)) return;
    const t = setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, key, ready]);
}

/**
 * Public page: connect a coding agent or Claude to Concord over MCP. Signed-in people also manage
 * their agent access here: the agents they've connected and their personal tokens.
 */
export function ConnectPage() {
  const { session } = useSession();
  const signedIn = !!session?.user;
  useHashScroll(['agents', 'tokens'], signedIn);
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
      {signedIn ? (
        <section aria-labelledby="your-agents" className="mt-8 space-y-6">
          <h2 id="your-agents" className="text-base font-semibold">
            Your agents
          </h2>
          <ConnectedAgents />
          <PersonalTokens />
        </section>
      ) : (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Bot className="size-4" />
          <span>You’ll sign in to Concord when your agent first connects.</span>
        </p>
      )}
    </Page>
  );
}
