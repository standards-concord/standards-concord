import { describe, expect, it } from 'vitest';
import { agentAppFor } from './AgentLogos';

describe('agentAppFor', () => {
  it('knows each app by the names it registers with', () => {
    expect(agentAppFor('Claude')).toBe('claude');
    expect(agentAppFor('Claude Code')).toBe('claude-code');
    expect(agentAppFor('Claude Code (concord)')).toBe('claude-code');
    expect(agentAppFor('ChatGPT')).toBe('chatgpt');
    expect(agentAppFor('Codex')).toBe('codex');
    expect(agentAppFor('Cursor')).toBe('cursor');
    expect(agentAppFor('Visual Studio Code')).toBe('vscode');
    expect(agentAppFor('VS Code')).toBe('vscode');
    expect(agentAppFor('VSCode')).toBe('vscode');
  });

  it('ignores case and runs of whitespace', () => {
    // "Claude  Code" used to fail the Claude Code pattern and fall through to Claude.
    expect(agentAppFor('claude  code')).toBe('claude-code');
    expect(agentAppFor('Claude\tCode')).toBe('claude-code');
    expect(agentAppFor(' CLAUDE CODE (concord) ')).toBe('claude-code');
    expect(agentAppFor('visual  studio\ncode')).toBe('vscode');
    expect(agentAppFor('chatgpt')).toBe('chatgpt');
  });

  it('gives no official mark to a name that only contains an app’s name', () => {
    // A brand word anywhere in the name used to be enough.
    for (const name of ['Not Claude', 'Unofficial ChatGPT Bridge', 'Cursor-malware', 'Claude Codex', 'My Codex fork', 'Claude Code helper', 'Claude Code (a) (b)', 'VS Code extension', 'Homemade research bot', ''])
      expect(agentAppFor(name), name).toBeUndefined();
  });

  it('allows a bracketed label only after Claude Code, which adds the server’s name', () => {
    for (const name of ['Cursor (malware)', 'ChatGPT (unofficial)', 'Claude (beta)', 'Codex (fork)', 'VS Code (preview)'])
      expect(agentAppFor(name), name).toBeUndefined();
  });

  it('treats names that look like object properties as ordinary unknown names', () => {
    // A plain-object alias table used to return Object.prototype members for these, which broke rendering.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Constructor (x)'])
      expect(agentAppFor(name), name).toBeUndefined();
  });
});
