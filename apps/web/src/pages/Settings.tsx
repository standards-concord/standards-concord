import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentToken } from '@concord/shared';
import { Bot, KeyRound, Lock, Trash2, Unplug, UserRound } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatDate, relativeTime, titleCase } from '../lib/format';
import { Page } from '../components/Shell';
import { GitHubIcon, GoogleIcon, WebIdIcon } from '../components/badges';
import { LookPicker } from '../components/LookPicker';
import { Avatar, Badge, Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Input, Loading, PageHeader } from '../components/ui';

function TokenCreator({ onCreated }: { onCreated?: (t: AgentToken) => void }) {
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


export function SettingsPage() {
  const { session, now } = useSession();
  const tokens = useAsync(() => api.agentTokens(), []);
  const revoke = useAction(async (id: string) => {
    await api.deleteAgentToken(id);
    await tokens.reload();
  });
  const connections = useAsync(() => api.oauthConnections(), []);
  const disconnect = useAction(async (id: string) => {
    await api.disconnectOAuth(id);
    await connections.reload();
  });
  useEffect(() => {
    const target = location.hash.slice(1);
    if (['tokens', 'agents', 'appearance'].includes(target)) setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 100);
  }, []);
  const u = session?.user;
  if (!u) return null;

  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Card>
          <CardHeader icon={UserRound} title="Profile" />
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

        <LookPicker />

        <Card>
          <CardHeader icon={Lock} title="Your WebID and Solid pod" />
          <div className="space-y-4 p-5">
            <p className="text-sm text-muted">
              {u.providers.some((p) => p.provider === 'solid' && p.subject === u.webId)
                ? 'You signed in with your own WebID. What Concord saves for you, such as interview transcripts, goes in a private pod we keep for you here, not in Concord’s database.'
                : 'Your private data — such as interview transcripts — lives in your own Solid pod, not in Concord’s database. We set this up for you automatically; you don’t need to do anything.'}
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
        </Card>

        <Card>
          <CardHeader title="Linked sign-in providers" />
          <ul className="divide-y divide-line">
            {u.providers.map((p) => (
              <li key={p.provider + p.subject} className="flex items-center gap-3 px-5 py-3 text-sm">
                {p.provider === 'google' ? <GoogleIcon /> : p.provider === 'github' ? <GitHubIcon /> : p.provider === 'solid' ? <WebIdIcon /> : <UserRound className="size-4 text-muted" />}
                <span className="font-medium">{p.provider === 'solid' ? 'Solid (your WebID)' : titleCase(p.provider)}</span>
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

        <div id="agents">
          <Card>
            <CardHeader
              icon={Bot}
              title="Connected agents"
              subtitle="Apps you’ve allowed to use Concord as you, such as Claude, Claude Code or Codex."
              actions={<Link to="/connect" className="text-sm text-accent hover:underline">Connect an agent</Link>}
            />
            {connections.error && !connections.data ? (
              <div className="px-5 pb-5">
                <ErrorCard error={connections.error} onRetry={connections.reload} />
              </div>
            ) : !connections.data ? (
              <Loading />
            ) : (
              <ul className="divide-y divide-line border-t border-line" data-testid="connections">
                {connections.data.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{c.clientName}</div>
                      <div className="text-xs text-muted">
                        Connected {formatDate(c.createdAt)} · {c.lastUsedAt ? `last used ${relativeTime(c.lastUsedAt, now())}` : 'not used yet'}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" icon={Unplug} disabled={disconnect.pending} onClick={() => confirm(`Disconnect “${c.clientName}”? It will need to sign in again.`) && void disconnect.run(c.id)}>
                      Disconnect
                    </Button>
                  </li>
                ))}
                {!connections.data.length && <li className="px-5 py-4 text-sm text-muted">No agents connected yet.</li>}
              </ul>
            )}
            <div className="px-5 pb-3">
              <InlineError error={disconnect.error} />
            </div>
          </Card>
        </div>

        <div id="tokens">
          <Card>
            <CardHeader icon={KeyRound} title="Personal tokens" subtitle="Only for agents that can’t open a browser to sign in, such as CI jobs. Send it as an Authorization: Bearer header." />
            <div className="p-5">
              <TokenCreator onCreated={() => void tokens.reload()} />
            </div>
            {tokens.error && !tokens.data ? (
              <div className="px-5 pb-5">
                <ErrorCard error={tokens.error} onRetry={tokens.reload} />
              </div>
            ) : !tokens.data ? (
              <Loading />
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {tokens.data.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-muted">
                        <code className="font-mono">{t.prefix}…</code> · created {formatDate(t.createdAt)} · {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt, now())}` : 'never used'}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" icon={Trash2} disabled={revoke.pending} onClick={() => confirm(`Revoke “${t.name}”? Agents using it will lose access.`) && void revoke.run(t.id)}>
                      Revoke
                    </Button>
                  </li>
                ))}
                {!tokens.data.length && <li className="px-5 py-4 text-sm text-muted">No tokens yet.</li>}
              </ul>
            )}
            <div className="px-5 pb-3">
              <InlineError error={revoke.error} />
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
