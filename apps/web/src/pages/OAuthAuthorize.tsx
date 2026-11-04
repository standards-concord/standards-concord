import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeftRight, BookOpen, FileSearch, MessageSquarePlus, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Logo } from '../components/badges';
import { Avatar, Button, Card, ErrorCard, InlineError, Loading } from '../components/ui';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';

/**
 * Consent page for MCP clients (Claude, Claude Code, Codex…). The server's
 * /authorize endpoint sends people here; Allow sends them back to the client
 * with an authorization code.
 */
export function OAuthAuthorizePage() {
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const { session, loading } = useSession();
  const req = useAsync(() => api.oauthRequest(id), [id]);
  const [leaving, setLeaving] = useState<'allowed' | 'denied'>();
  const go = (redirect: string, how: 'allowed' | 'denied') => {
    setLeaving(how);
    window.location.assign(redirect);
  };
  const allow = useAction(async () => go((await api.approveOAuth(id)).redirect, 'allowed'));
  const deny = useAction(async () => go((await api.denyOAuth(id)).redirect, 'denied'));
  const here = `/oauth/authorize?request=${encodeURIComponent(id)}`;
  const user = session?.user;

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-12">
      <div className="mb-6 flex items-center justify-center gap-3">
        <Logo className="size-10" />
        <ArrowLeftRight className="size-4 text-subtle" />
        <div className="grid size-10 place-items-center rounded-lg bg-surface-2 text-sm font-semibold" aria-hidden>
          {req.data?.logoUri ? <img src={req.data.logoUri} alt="" className="size-10 rounded-lg" /> : (req.data?.clientName ?? '?').slice(0, 1).toUpperCase()}
        </div>
      </div>

      {leaving ? (
        <Card className="p-6 text-center">
          <p className="font-medium" data-testid="oauth-done">{leaving === 'allowed' ? `Connected. Taking you back to ${req.data?.clientName ?? 'your app'}…` : 'Cancelled.'}</p>
          <p className="mt-2 text-sm text-muted">You can close this tab once your agent says it’s connected.</p>
        </Card>
      ) : req.error ? (
        <ErrorCard title="Can’t connect" error={req.error} />
      ) : !req.data || (!session && loading) ? (
        <Loading />
      ) : (
        <Card className="p-6">
          <h1 className="text-center text-xl font-semibold tracking-tight" data-testid="oauth-title">
            {req.data.clientName} wants to connect to Concord
          </h1>
          {req.data.clientUri && (
            <p className="mt-1 text-center text-xs text-muted">
              <a href={req.data.clientUri} target="_blank" rel="noreferrer" className="hover:underline">
                {new URL(req.data.clientUri).host}
              </a>
            </p>
          )}

          {!user ? (
            <div className="mt-6 space-y-3 text-center">
              <p className="text-sm text-muted">Sign in to Concord to continue.</p>
              <Link to={`/login?next=${encodeURIComponent(here)}`} className="block">
                <Button variant="primary" size="lg" className="w-full" data-testid="oauth-sign-in">
                  Sign in
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="mt-5 flex items-center gap-3 rounded-lg bg-surface-2 p-3">
                <Avatar name={user.name} src={user.avatarUrl} size={32} />
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium">{user.name}</div>
                  <div className="text-xs text-muted">It will act as you</div>
                </div>
              </div>
              <ul className="mt-5 space-y-2.5 text-sm">
                <li className="flex gap-2.5">
                  <BookOpen className="mt-0.5 size-4 shrink-0 text-muted" /> Read the hub’s ontologies, in any format
                </li>
                <li className="flex gap-2.5">
                  <FileSearch className="mt-0.5 size-4 shrink-0 text-muted" /> Search terms, run queries and check data against them
                </li>
                <li className="flex gap-2.5">
                  <MessageSquarePlus className="mt-0.5 size-4 shrink-0 text-muted" /> Report gaps and propose changes in your name
                </li>
              </ul>
              <p className="mt-5 flex gap-2 border-t border-line pt-4 text-xs text-muted">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  After you allow, you’ll go back to <strong className="font-mono">{req.data.redirectHost}</strong>
                  {req.data.localRedirect ? ' (an app on this computer)' : ''}. You can disconnect it any time in Settings.
                </span>
              </p>
              <div className="mt-5 flex gap-2">
                <Button className="flex-1" onClick={() => void deny.run()} loading={deny.pending} disabled={allow.pending} data-testid="oauth-deny">
                  Cancel
                </Button>
                <Button variant="primary" className="flex-1" onClick={() => void allow.run()} loading={allow.pending} disabled={deny.pending} data-testid="oauth-allow">
                  Allow
                </Button>
              </div>
              <InlineError error={allow.error ?? deny.error} />
            </>
          )}
        </Card>
      )}
    </div>
  );
}
