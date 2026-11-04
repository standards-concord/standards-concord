import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Bot } from 'lucide-react';
import { loginHref, Page } from '../components/Shell';
import { ConnectAgent } from '../components/ConnectAgent';
import { ConnectedAgents, PersonalTokens } from '../components/AgentAccess';
import { Card, PageHeader } from '../components/ui';
import { useSession } from '../lib/session';

const SECTION_IDS = ['setup', 'agents', 'tokens'];

/** Scrolls to and focuses #setup, #agents or #tokens when the page opens with that hash, or when a link to it is followed. */
function useHashFocus(ready: boolean) {
  const { hash, key } = useLocation();
  useEffect(() => {
    const target = hash.slice(1);
    if (!ready || !SECTION_IDS.includes(target)) return;
    const t = setTimeout(() => {
      const el = document.getElementById(target);
      if (!el) return;
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    }, 100);
    return () => clearTimeout(t);
  }, [hash, key, ready]);
}

/**
 * Everything about agents in one place: how to connect one and, when signed in, the agents you've
 * connected and your personal tokens. The account menu's page and each ontology's Explore tab both show it.
 */
export function AgentHub({ example }: { example?: ReactNode }) {
  const { session } = useSession();
  const { pathname, search, hash } = useLocation();
  const signedIn = !!session?.user;
  useHashFocus(signedIn);
  const jump = (id: string, label: string) => (
    <Link to={{ hash: id }} className="rounded-pill border border-line px-3 py-1 text-sm hover:bg-surface-2">
      {label}
    </Link>
  );
  return (
    <div className="space-y-6">
      {signedIn && (
        <nav aria-label="On this page" className="flex flex-wrap gap-2">
          {jump('setup', 'Connect an agent')}
          {jump('agents', 'Connected agents')}
          {jump('tokens', 'Personal tokens')}
        </nav>
      )}
      <div id="setup" tabIndex={-1} className="scroll-mt-20 outline-none">
        <Card className="space-y-4 p-5">
          <ConnectAgent />
          {example}
        </Card>
      </div>
      {signedIn ? (
        <section aria-labelledby="your-agents" className="space-y-6">
          <h2 id="your-agents" className="text-base font-semibold">
            Your agents
          </h2>
          <ConnectedAgents />
          <PersonalTokens />
        </section>
      ) : (
        <div className="space-y-2 text-sm text-muted">
          <p className="flex items-center gap-2">
            <Bot className="size-4" />
            <span>You’ll sign in to Concord when your agent first connects.</span>
          </p>
          <p>
            <Link to={loginHref({ pathname, search, hash: hash || '#agents' })} className="font-medium text-accent hover:underline">
              Sign in to see your connected agents and personal tokens
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}

/** Public page: connect a coding agent or Claude to Concord over MCP, and manage your agents and tokens. */
export function ConnectPage() {
  return (
    <Page>
      <PageHeader
        eyebrow="Agents"
        title="Connect your agent to Concord"
        subtitle="Let Claude, ChatGPT, Claude Code, Codex or your editor read Concord’s ontologies, check data against them and report what’s missing."
      />
      <AgentHub />
    </Page>
  );
}
