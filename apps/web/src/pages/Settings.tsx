import { Link, Navigate, useLocation } from 'react-router';
import { Bot, Lock, LogIn, UserRound } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { formatDate, titleCase } from '../lib/format';
import { Page } from '../components/Shell';
import { GitHubIcon, GoogleIcon } from '../components/badges';
import { CollapsibleCard } from '../components/Disclosure';
import { Avatar, Badge, Button, Card, CardHeader, CopyButton, PageHeader } from '../components/ui';

/** The signed-in person's profile: who they are, how they sign in, and where their private data lives. */
export function SettingsPage() {
  const { session } = useSession();
  const { hash } = useLocation();
  const u = session?.user;
  if (!u) return null;
  // Agents, tokens and appearance used to live here; old links still land in the right place.
  const moved = { '#agents': '/connect#agents', '#tokens': '/connect#tokens', '#appearance': '/appearance' }[hash];
  if (moved) return <Navigate to={moved} replace />;

  return (
    <Page>
      <PageHeader title="Profile" />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center gap-4 p-5">
            <Avatar name={u.name} src={u.avatarUrl} size={56} />
            <div className="min-w-0">
              <div className="text-lg font-semibold">{u.name}</div>
              {u.email && <div className="text-sm text-muted">{u.email}</div>}
              {u.organisation && <div className="text-sm text-muted">{u.organisation}</div>}
              {u.simulated && <Badge tone="warn" className="mt-1">Simulated persona</Badge>}
              <div className="mt-1 text-xs text-subtle">Joined {formatDate(u.createdAt)}</div>
            </div>
          </div>
          {u.persona && <p className="border-t border-line px-5 py-4 text-sm text-muted">{u.persona}</p>}
        </Card>

        <Card>
          <CardHeader icon={LogIn} title="Ways to sign in" subtitle="Each of these opens this same Concord account. Linking another one gives you a second way in; it doesn’t share your Concord data with it." />
          <ul className="divide-y divide-line">
            {u.providers.map((p) => (
              <li key={p.provider + p.subject} className="flex items-center gap-3 px-5 py-3 text-sm">
                {p.provider === 'google' ? <GoogleIcon /> : p.provider === 'github' ? <GitHubIcon /> : <UserRound className="size-4 text-muted" />}
                <span className="font-medium">{titleCase(p.provider)}</span>
                <span className="truncate text-xs text-muted">{p.subject}</span>
              </li>
            ))}
          </ul>
          {(session.providers.google || session.providers.github) && (
            <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
              {session.providers.google && !u.providers.some((p) => p.provider === 'google') && (
                <a href={api.oauthUrl('google', '/settings')}>
                  <Button size="sm">
                    <GoogleIcon className="size-3.5" /> Link Google
                  </Button>
                </a>
              )}
              {session.providers.github && !u.providers.some((p) => p.provider === 'github') && (
                <a href={api.oauthUrl('github', '/settings')}>
                  <Button size="sm">
                    <GitHubIcon className="size-3.5" /> Link GitHub
                  </Button>
                </a>
              )}
            </div>
          )}
        </Card>

        <CollapsibleCard id="webid" icon={Lock} title="Your WebID and Solid pod" subtitle="Where your private data lives. Concord set this up for you; there’s nothing you need to do." keepMounted>
          <div className="space-y-4 p-5">
            <p className="text-sm text-muted">
              Your private data, such as interview transcripts, lives in your own Solid pod rather than in Concord’s database. Your WebID is the web address that identifies you to your pod and to other Solid apps.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">WebID</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{u.webId}</code>
                <CopyButton text={u.webId} />
              </div>
            </div>
            {u.podUrl && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Pod</div>
                <div className="flex items-center gap-2">
                  <a href={u.podUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-accent hover:underline">
                    {u.podUrl}
                  </a>
                  <CopyButton text={u.podUrl} />
                </div>
              </div>
            )}
            {session?.solid && !session.solid.enabled && <p className="text-xs text-warn">This server is running without a Solid server, so private data is kept in local private storage instead.</p>}
          </div>
        </CollapsibleCard>

        <p className="flex items-center gap-2 text-sm text-muted">
          <Bot className="size-4" />
          <span>
            Agents you’ve connected and personal tokens are on <Link to="/connect#agents" className="text-accent hover:underline">Connect an agent</Link>. The look of the app is under <Link to="/appearance" className="text-accent hover:underline">Appearance</Link>.
          </span>
        </p>
      </div>
    </Page>
  );
}
