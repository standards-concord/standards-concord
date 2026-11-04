/**
 * A minimal MCP client over Streamable HTTP, enough to call Concord's tools the way
 * Claude Code would, so the tool results shown in the video are real.
 */
export class McpClient {
  private id = 0;
  private ready?: Promise<void>;
  tools: string[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly clientName = 'claude-code',
  ) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-agent-name': 'Claude Code' },
      body: JSON.stringify(body),
    });
    if (notify) return;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${method}: ${res.status} ${text.slice(0, 300)}`);
    // Either a JSON body or an SSE stream with one "data:" message.
    const payload = res.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5)))
          .find((m) => m.id === body.id)
      : JSON.parse(text);
    if (payload?.error) throw new Error(`MCP ${method}: ${payload.error.message}`);
    return payload?.result;
  }

  connect() {
    this.ready ??= (async () => {
      await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.clientName, version: '2.1.0' } });
      await this.rpc('notifications/initialized', undefined, true);
      const list = await this.rpc('tools/list', {});
      this.tools = (list?.tools ?? []).map((t: { name: string }) => t.name);
    })();
    return this.ready;
  }

  /** Calls a tool and returns its text content (and whether it was an error). */
  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; json?: any }> {
    await this.connect();
    const r = await this.rpc('tools/call', { name, arguments: args });
    const text = (r?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { text, isError: !!r?.isError, json };
  }
}
