import { useEffect } from 'react';
import { KeyRound, Lock, Trash2, UserRound } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatDate, relativeTime, titleCase } from '../lib/format';
import { Page } from '../components/Shell';
import { GitHubIcon, GoogleIcon } from '../components/badges';
import { TokenCreator } from './ontology/Agents';
import { LookPicker } from '../components/LookPicker';
import { Avatar, Badge, Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Loading, PageHeader } from '../components/ui';

export function SettingsPage() {
  const { session, now } = useSession();
  const tokens = useAsync(() => api.agentTokens(), []);
  const revoke = useAction(async (id: string) => {
    await api.deleteAgentToken(id);
    await tokens.reload();
  });
  useEffect(() => {
    const target = { '#tokens': 'tokens', '#appearance': 'appearance' }[location.hash];
    if (target) setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' }), 100);
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
              Your private data — such as interview transcripts — lives in your own Solid pod, not in Concord’s database. We set this up for you automatically; you don’t need to do anything.
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

        <div id="tokens">
          <Card>
            <CardHeader icon={KeyRound} title="Agent tokens" subtitle="For connecting Claude Code, Codex or other MCP clients. Each ontology’s Agents tab has setup snippets." />
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
