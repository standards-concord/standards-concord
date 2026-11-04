import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Package } from 'lucide-react';
import { CHATGPT_PLUGINS_URL, claudeCodeCommand, claudeCodePluginCommands, claudeConnectorLink, codexCommand, codexLoginCommand, codexPluginCommand, cursorLink, mcpUrl, vscodeLink } from '../lib/install';
import { useSession } from '../lib/session';
import { CopyButton, cx } from './ui';

const origin = () => (typeof location !== 'undefined' ? location.origin : '');

function Command({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{code}</code>
      <CopyButton text={code} label={label} />
    </div>
  );
}

const linkButton = 'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors';

function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <rect width="24" height="24" rx="6" fill="#d97757" />
      <path d="M12 5v14M5 12h14M7.05 7.05l9.9 9.9M16.95 7.05l-9.9 9.9" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function TerminalMark({ label, bg }: { label: string; bg: string }) {
  return (
    <span className="grid size-6 place-items-center rounded-md font-mono text-[0.65rem] font-bold text-white" style={{ background: bg }} aria-hidden>
      {label}
    </span>
  );
}

type ClientId = 'claude' | 'chatgpt' | 'claude-code' | 'codex' | 'cursor' | 'vscode';
const CLIENTS: { id: ClientId; name: string; logo: ReactNode }[] = [
  { id: 'claude', name: 'Claude', logo: <ClaudeMark /> },
  { id: 'chatgpt', name: 'ChatGPT', logo: <TerminalMark label="G" bg="#10a37f" /> },
  { id: 'claude-code', name: 'Claude Code', logo: <TerminalMark label=">_" bg="#b4532a" /> },
  { id: 'codex', name: 'Codex', logo: <TerminalMark label="cx" bg="#111" /> },
  { id: 'cursor', name: 'Cursor', logo: <TerminalMark label="Cu" bg="#3b3b3b" /> },
  { id: 'vscode', name: 'VS Code', logo: <TerminalMark label="VS" bg="#0e6fc4" /> },
];
const STORE_KEY = 'concord.connect.client';
const remembered = (): ClientId => {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return CLIENTS.some((c) => c.id === v) ? (v as ClientId) : 'claude';
  } catch {
    return 'claude';
  }
};

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">{children}</div>
    </li>
  );
}

function ClientSteps({ client, url }: { client: ClientId; url: string }) {
  const signIn = <p>Sign in to Concord in the browser window that opens, and click Allow.</p>;
  switch (client) {
    case 'claude':
      return (
        <ol className="space-y-4" data-testid="install-claude">
          <Step n={1}>
            <p>Add Concord as a connector. This opens claude.ai with everything filled in.</p>
            <a href={claudeConnectorLink(url)} target="_blank" rel="noreferrer" className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover')} data-testid="add-to-claude">
              Add to Claude <ExternalLink className="size-3.5" />
            </a>
          </Step>
          <Step n={2}>{signIn}</Step>
          <Step n={3}>
            <p>Use it in Claude on the web, desktop or mobile, and in Claude Code when you’re signed in with your Claude account.</p>
          </Step>
        </ol>
      );
    case 'chatgpt':
      return (
        <ol className="space-y-4" data-testid="install-chatgpt">
          <Step n={1}>
            <p>Copy Concord’s server URL:</p>
            <Command code={url} label="Copy" />
          </Step>
          <Step n={2}>
            <p>
              Open ChatGPT’s Plugins page, choose <em>+</em> then <em>Add custom MCP server</em>. Name it Concord, paste the URL under <em>Connection</em>, pick <em>OAuth</em> for authentication, accept the warning and choose <em>Create as a plugin</em>.
            </p>
            <a href={CHATGPT_PLUGINS_URL} target="_blank" rel="noreferrer" className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover')} data-testid="open-chatgpt">
              Open ChatGPT <ExternalLink className="size-3.5" />
            </a>
            <p className="text-xs">
              If you don’t see that option, look under Settings → Apps → Advanced, where some plans need <em>Developer mode</em> turned on first. In a Business or Enterprise workspace, an admin may have to allow custom MCP servers.
            </p>
          </Step>
          <Step n={3}>
            <p>
              Open the new Concord plugin under your plugins and choose <em>Install</em>. When ChatGPT asks, sign in to Concord and click Allow.
            </p>
          </Step>
          <Step n={4}>
            <p>
              In a chat, type <code className="font-mono">@</code> and pick <em>Concord</em>, then ask about the hub’s ontologies.
            </p>
          </Step>
        </ol>
      );
    case 'claude-code':
      return (
        <ol className="space-y-4" data-testid="install-claude-code">
          <Step n={1}>
            <p>Run this in a terminal:</p>
            <Command code={claudeCodeCommand(url)} label="Copy" />
          </Step>
          <Step n={2}>
            <p>
              In Claude Code, type <code className="font-mono">/mcp</code>, pick <em>concord</em> and choose <em>Authenticate</em>.
            </p>
          </Step>
          <Step n={3}>{signIn}</Step>
        </ol>
      );
    case 'codex':
      return (
        <ol className="space-y-4" data-testid="install-codex">
          <Step n={1}>
            <p>Run this in a terminal:</p>
            <Command code={codexCommand(url)} label="Copy" />
            <p className="text-xs">In the Codex app instead: Settings → MCP servers → Add server → Streamable HTTP, and paste the server URL.</p>
          </Step>
          <Step n={2}>
            <p>If Codex doesn’t open a browser by itself, run:</p>
            <Command code={codexLoginCommand()} label="Copy" />
          </Step>
          <Step n={3}>{signIn}</Step>
        </ol>
      );
    case 'cursor':
      return (
        <ol className="space-y-4" data-testid="install-cursor">
          <Step n={1}>
            <p>Open Cursor and add Concord:</p>
            <a href={cursorLink(url)} className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover')} data-testid="add-to-cursor">
              Add to Cursor
            </a>
          </Step>
          <Step n={2}>{signIn}</Step>
        </ol>
      );
    case 'vscode':
      return (
        <ol className="space-y-4" data-testid="install-vscode">
          <Step n={1}>
            <p>Open VS Code and add Concord:</p>
            <a href={vscodeLink(url)} className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover')} data-testid="add-to-vscode">
              Add to VS Code
            </a>
          </Step>
          <Step n={2}>{signIn}</Step>
        </ol>
      );
  }
}

/**
 * How to connect Claude, Claude Code, Codex and editors to Concord's MCP server.
 * The person picks their client and sees only its steps. Every client signs the
 * person in with OAuth on first use: no token to copy.
 */
export function ConnectAgent() {
  const url = mcpUrl(origin());
  const signedIn = !!useSession().session?.user;
  const [client, setClient] = useState<ClientId>(remembered);
  const choose = (c: ClientId) => {
    setClient(c);
    try {
      localStorage.setItem(STORE_KEY, c);
    } catch {
      /* private mode: just don't remember */
    }
  };
  return (
    <div className="space-y-5" data-testid="connect-agent">
      <div>
        <div className="mb-2 text-sm font-medium" id="client-picker-label">
          Which app are you connecting?
        </div>
        <div role="radiogroup" aria-labelledby="client-picker-label" className="flex flex-wrap gap-2">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={client === c.id}
              tabIndex={client === c.id ? 0 : -1}
              onClick={() => choose(c.id)}
              onKeyDown={(e) => {
                // A radio group: one tab stop, and the arrow keys move and select, like the Appearance picker.
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                if (!step) return;
                e.preventDefault();
                const i = (CLIENTS.findIndex((x) => x.id === client) + step + CLIENTS.length) % CLIENTS.length;
                choose(CLIENTS[i].id);
                (e.currentTarget.parentElement?.children[i] as HTMLElement | undefined)?.focus();
              }}
              className={cx(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                client === c.id ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong hover:bg-surface-2',
              )}
            >
              {c.logo}
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
        <ClientSteps client={client} url={url} />
      </div>

      <details className="rounded-xl border border-line p-4 text-sm" data-testid="advanced-setup">
        <summary className="cursor-pointer font-medium">Advanced setup</summary>
        <div className="mt-3 space-y-4 text-muted">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-fg">Server URL, for any other MCP client (Streamable HTTP, OAuth)</div>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 font-mono text-xs break-all" data-testid="mcp-url">
                {url}
              </code>
              <CopyButton text={url} label="Copy" />
            </div>
          </div>
          <div className="space-y-1.5" data-testid="plugin-install">
            <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
              <Package className="size-3.5" /> Install as a plugin
            </div>
            <p className="text-xs" data-testid="plugin-update-note">
              Plugins use Concord’s main public address. If Concord moves, plugins don’t always update by themselves: in Claude Code run{' '}
              <code className="font-mono">/plugin marketplace update concord</code> (or turn on auto-update for this marketplace in{' '}
              <code className="font-mono">/plugin</code>), and in Codex update Concord from the Plugins directory. Then sign in again, because a new address needs a new
              sign-in.
            </p>
            {claudeCodePluginCommands().map((c) => (
              <Command key={c} code={c} label="Copy" />
            ))}
            <Command code={codexPluginCommand()} label="Copy" />
            <p className="text-xs">In Codex, then install Concord from the Plugins directory.</p>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-fg">Agents that can’t open a browser</div>
            <p className="text-xs">
              For CI jobs and other headless agents, create a{' '}
              <Link to={signedIn ? '/connect#tokens' : `/login?next=${encodeURIComponent('/connect#tokens')}`} className="text-accent hover:underline">
                personal token
              </Link>{' '}
              and send it as an <code className="font-mono">Authorization: Bearer</code> header.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
