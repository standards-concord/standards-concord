import type { ReactNode } from 'react';
import { ExternalLink, Package } from 'lucide-react';
import { claudeCodeCommand, claudeCodePluginCommands, claudeConnectorLink, codexCommand, codexLoginCommand, codexPluginCommand, cursorLink, mcpUrl, vscodeLink } from '../lib/install';
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

function ClientCard({ name, logo, children, action, testId }: { name: string; logo: ReactNode; children: ReactNode; action: ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" data-testid={testId}>
      <div className="flex items-center gap-2.5">
        {logo}
        <span className="font-semibold">{name}</span>
      </div>
      <div className="flex-1 space-y-2 text-sm text-muted">{children}</div>
      {action}
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

/**
 * How to connect Claude, Claude Code, Codex and editors to Concord's MCP server.
 * Every client signs the person in with OAuth on first use: no token to copy.
 */
export function ConnectAgent({ compact }: { compact?: boolean }) {
  const url = mcpUrl(origin());
  return (
    <div className="space-y-4" data-testid="connect-agent">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">MCP server URL</span>
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-mono text-sm" data-testid="mcp-url">
          {url}
        </code>
        <CopyButton text={url} label="Copy" />
      </div>
      <p className="text-sm text-muted">The first time an agent connects, it opens your browser so you can sign in to Concord and allow it. There’s no token to copy.</p>

      <div className="grid gap-3 md:grid-cols-3">
        <ClientCard
          testId="install-claude"
          name="Claude"
          logo={<ClaudeMark />}
          action={
            <a href={claudeConnectorLink(url)} target="_blank" rel="noreferrer" className={cx(linkButton, 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover')} data-testid="add-to-claude">
              Add to Claude <ExternalLink className="size-3.5" />
            </a>
          }
        >
          <p>Opens claude.ai with Concord filled in. It then works in Claude on the web, desktop and mobile, and in Claude Code when you’re signed in with your Claude account.</p>
        </ClientCard>

        <ClientCard testId="install-claude-code" name="Claude Code" logo={<TerminalMark label=">_" bg="#b4532a" />} action={<Command code={claudeCodeCommand(url)} label="Copy" />}>
          <p>
            Run this once, then type <code className="font-mono">/mcp</code> in Claude Code and choose <em>Authenticate</em>.
          </p>
        </ClientCard>

        <ClientCard testId="install-codex" name="Codex" logo={<TerminalMark label="cx" bg="#111" />} action={<Command code={codexCommand(url)} label="Copy" />}>
          <p>
            Run this, then <code className="font-mono">{codexLoginCommand()}</code> to sign in. In the Codex app, use Settings → MCP servers → Add server and paste the URL.
          </p>
        </ClientCard>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Other editors:</span>
        <a href={cursorLink(url)} className={cx(linkButton, 'h-8 border border-line-strong px-2.5 text-xs hover:bg-surface-2')} data-testid="add-to-cursor">
          Add to Cursor
        </a>
        <a href={vscodeLink(url)} className={cx(linkButton, 'h-8 border border-line-strong px-2.5 text-xs hover:bg-surface-2')} data-testid="add-to-vscode">
          Add to VS Code
        </a>
        <span className="text-xs text-subtle">Any other MCP client: add the URL above as a Streamable HTTP server.</span>
      </div>

      {!compact && (
        <details className="rounded-xl border border-line p-4 text-sm" data-testid="plugin-install">
          <summary className="flex cursor-pointer items-center gap-2 font-medium">
            <Package className="size-4" /> Install as a plugin instead
          </summary>
          <div className="mt-3 space-y-3 text-muted">
            <p>The plugins point at Concord’s main public address and update themselves when it moves, so you won’t need to reinstall after a domain change.</p>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fg">Claude Code</div>
              {claudeCodePluginCommands().map((c) => (
                <Command key={c} code={c} label="Copy" />
              ))}
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fg">Codex</div>
              <Command code={codexPluginCommand()} label="Copy" />
              <p className="text-xs">Then install Concord from the Plugins directory in the Codex app.</p>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
