/**
 * Install links and commands for Concord's MCP server.
 *
 * Everything is built from the origin the page is served from, so a preview
 * deployment, a custom domain or localhost each point agents at themselves.
 * The plugin marketplaces in the repo (.claude-plugin, .agents/plugins) pin
 * the main public URL instead, so plugin installs follow Concord when it moves.
 */

export const SERVER_NAME = 'concord';
export const DISPLAY_NAME = 'Concord';
/** The GitHub repo that doubles as a Claude Code and Codex plugin marketplace. */
export const MARKETPLACE_REPO = 'jeswr/standards-concord';

export const mcpUrl = (origin: string) => `${origin.replace(/\/$/, '')}/mcp`;

/** Opens claude.ai's "Add custom connector" dialog, prefilled. Connectors added there also appear in Claude Desktop, mobile and Claude Code. */
export const claudeConnectorLink = (url: string) =>
  `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: 'add-custom-connector', connectorName: DISPLAY_NAME, connectorUrl: url })}`;

/**
 * ChatGPT has no link that prefills a custom MCP server, so the page opens ChatGPT's
 * Plugins page and the person pastes the URL. ChatGPT signs in with OAuth like Claude does.
 */
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

export const claudeCodeCommand = (url: string) => `claude mcp add --transport http ${SERVER_NAME} ${url}`;
export const claudeCodePluginCommands = () => [`/plugin marketplace add ${MARKETPLACE_REPO}`, `/plugin install ${SERVER_NAME}@${SERVER_NAME}`];

export const codexCommand = (url: string) => `codex mcp add ${SERVER_NAME} --url ${url}`;
export const codexLoginCommand = () => `codex mcp login ${SERVER_NAME}`;
export const codexPluginCommand = () => `codex plugin marketplace add ${MARKETPLACE_REPO}`;

const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Cursor's documented MCP install deep link. */
export const cursorLink = (url: string) => `cursor://anysphere.cursor-deeplink/mcp/install?${new URLSearchParams({ name: SERVER_NAME, config: base64(JSON.stringify({ url })) })}`;

/** VS Code's documented MCP install link. */
export const vscodeLink = (url: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: 'http', url }))}`;
