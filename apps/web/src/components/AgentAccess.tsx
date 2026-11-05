import { useRef, useState, type RefObject } from 'react';
import type { AgentToken } from '@concord/shared';
import { Bot, KeyRound, Trash2, Unplug } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatDate, relativeTime } from '../lib/format';
import { Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Input, Loading } from './ui';

/** The signed-in person's agent access, shown under the connect instructions: OAuth connections and personal tokens. */

function TokenCreator({ onCreate, pending, blocked, inputRef }: { onCreate: (name: string) => void; pending: boolean; blocked?: boolean; inputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState('My coding agent');
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <Input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" aria-label="Token name" />
        <Button variant="primary" icon={KeyRound} loading={pending} disabled={blocked} aria-describedby={blocked ? 'token-blocked' : undefined} onClick={() => onCreate(name.trim() || 'Agent')}>
          Create token
        </Button>
      </div>
      {/* A new token's secret can't be shown again, so never replace one that hasn't been saved yet. */}
      {blocked && (
        <p id="token-blocked" className="text-xs text-muted">
          Save the token below and choose “I’ve saved it” before creating another.
        </p>
      )}
    </div>
  );
}

/** Apps the person has connected with OAuth, with a Disconnect button for each. */
export function ConnectedAgents() {
  const { now } = useSession();
  const connections = useAsync(() => api.oauthConnections(), []);
  const disconnect = useAction(async (id: string) => {
    await api.disconnectOAuth(id);
    await connections.reload();
  });
  return (
    <div id="agents" tabIndex={-1} className="scroll-mt-20 outline-none">
      <Card>
        <CardHeader icon={Bot} title="Connected agents" subtitle="Apps you’ve allowed to use Concord as you, such as Claude, Claude Code or Codex." />
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
                <Button size="sm" variant="ghost" icon={Unplug} aria-label={`Disconnect ${c.clientName}`} disabled={disconnect.pending} onClick={() => confirm(`Disconnect “${c.clientName}”? It will need to sign in again.`) && void disconnect.run(c.id)}>
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
  );
}

/** Personal tokens for headless agents: create, list and revoke. A new token is shown once, until it's dismissed or revoked. */
export function PersonalTokens() {
  const { now } = useSession();
  const tokens = useAsync(() => api.agentTokens(), []);
  const [created, setCreated] = useState<AgentToken>();
  const nameRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const create = useAction(async (name: string) => {
    const t = await api.createAgentToken(name);
    setCreated(t);
    setStatus(`Created token “${t.name}”. Copy it now.`);
    await tokens.reload();
  });
  const revoke = useAction(async (t: AgentToken) => {
    await api.deleteAgentToken(t.id);
    if (created?.id === t.id) setCreated(undefined);
    setStatus(`Revoked token “${t.name}”.`);
    await tokens.reload();
  });
  return (
    <div id="tokens" tabIndex={-1} className="scroll-mt-20 outline-none">
      <Card>
        <CardHeader icon={KeyRound} title="Personal tokens" subtitle="Only for agents that can’t open a browser to sign in, such as CI jobs. Send it as an Authorization: Bearer header." />
        <div className="space-y-3 p-5">
          <p className="text-xs text-muted">A token acts as you, with everything your account can do, and doesn’t expire. Revoke it here when the agent no longer needs it.</p>
          <TokenCreator onCreate={(name) => void create.run(name)} pending={create.pending} blocked={!!created?.token} inputRef={nameRef} />
          <InlineError error={create.error} />
          {created?.token && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft p-3" data-testid="new-token">
              <p className="mb-2 text-sm font-medium">Copy “{created.name}” now. It won’t be shown again.</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1.5 font-mono text-xs">{created.token}</code>
                <CopyButton text={created.token} label="Copy" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreated(undefined);
                    // The button disappears with the reveal, so keep keyboard users in the token form.
                    nameRef.current?.focus();
                  }}
                >
                  I’ve saved it
                </Button>
              </div>
            </div>
          )}
          <p role="status" className="sr-only">
            {status}
          </p>
        </div>
        {tokens.error && !tokens.data ? (
          <div className="px-5 pb-5">
            <ErrorCard error={tokens.error} onRetry={tokens.reload} />
          </div>
        ) : !tokens.data ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-line border-t border-line" aria-label="Your personal tokens">
            {tokens.data.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted">
                    <code className="font-mono">{t.prefix}…</code> · created {formatDate(t.createdAt)} · {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt, now())}` : 'never used'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Revoke ${t.name}`} disabled={revoke.pending} onClick={() => confirm(`Revoke “${t.name}”? Agents using it will lose access.`) && void revoke.run(t)}>
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
  );
}
