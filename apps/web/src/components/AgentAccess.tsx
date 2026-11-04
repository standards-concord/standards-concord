import { useState } from 'react';
import type { AgentToken } from '@concord/shared';
import { Bot, KeyRound, Trash2, Unplug } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatDate, relativeTime } from '../lib/format';
import { Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Input, Loading } from './ui';

/** The signed-in person's agent access, shown under the connect instructions: OAuth connections and personal tokens. */

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

/** Apps the person has connected with OAuth, with a Disconnect button for each. */
export function ConnectedAgents() {
  const { now } = useSession();
  const connections = useAsync(() => api.oauthConnections(), []);
  const disconnect = useAction(async (id: string) => {
    await api.disconnectOAuth(id);
    await connections.reload();
  });
  return (
    <div id="agents" className="scroll-mt-20">
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
  );
}

/** Personal tokens for headless agents: create, list and revoke. */
export function PersonalTokens() {
  const { now } = useSession();
  const tokens = useAsync(() => api.agentTokens(), []);
  const revoke = useAction(async (id: string) => {
    await api.deleteAgentToken(id);
    await tokens.reload();
  });
  return (
    <div id="tokens" className="scroll-mt-20">
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
  );
}
