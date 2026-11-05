import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowLeftRight, BookOpen, FileSearch, MessageSquarePlus, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Logo } from '../components/badges';
import { Avatar, Button, Card, ErrorCard, InlineError, Loading, LinkButton } from '../components/ui';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';

/** https, http on this computer, or a native app's reverse-domain scheme. Never javascript:, data: and the like. */
export function isSafeReturnUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(u.protocol);
}

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
    // The server only hands back vetted return addresses; refuse anything that could run script here anyway.
    if (!isSafeReturnUrl(redirect)) throw new Error('This app’s return address is not allowed.');
    setLeaving(how);
    window.location.assign(redirect);
  };
  const allow = useAction(async () => go((await api.approveOAuth(id)).redirect, 'allowed'));
  const deny = useAction(async () => go((await api.denyOAuth(id)).redirect, 'denied'));
  const here = `/oauth/authorize?request=${encodeURIComponent(id)}`;
  const user = session?.user;
  const websiteHost = req.data?.clientUri ? new URL(req.data.clientUri).host : undefined;

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
          <p className="mt-1 text-center text-xs text-muted" data-testid="oauth-identity">
            {req.data.publisher ? (
              <>
                Identified by <strong className="font-mono">{req.data.publisher}</strong>
                {websiteHost && websiteHost !== req.data.publisher ? <> · says its website is {websiteHost}</> : null}
              </>
            ) : (
              <>
                Concord can’t confirm who made this app: its name{websiteHost ? <> and website ({websiteHost})</> : null} are its own claims.
              </>
            )}
          </p>
          <div className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-center text-sm" data-testid="oauth-destination">
            {req.data.redirectKind === 'native' ? (
              <>
                Access will be sent to an app installed on this device that opens <strong className="font-mono">{req.data.redirectHost}</strong> links.
              </>
            ) : (
              <>
                Access will be sent to <strong className="font-mono">{req.data.redirectHost}</strong>
                {req.data.localRedirect ? ' (an app on this computer)' : ''}.
              </>
            )}
            <div className="mt-1 text-xs text-muted">Only allow if that’s the app you’re connecting.</div>
          </div>

          {!user ? (
            <div className="mt-6 space-y-3 text-center">
              <p className="text-sm text-muted">Sign in to Concord to continue.</p>
              <LinkButton to={`/login?next=${encodeURIComponent(here)}`} variant="primary" size="lg" data-testid="oauth-sign-in" className="flex w-full">
                  Sign in
                </LinkButton>
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
                <li className="flex gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" /> Covers every ontology you can see on the hub, including working drafts
                </li>
              </ul>
              <p className="mt-5 flex gap-2 border-t border-line pt-4 text-xs text-muted">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                <span>You can disconnect it any time in Settings.</span>
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
