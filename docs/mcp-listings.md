# Getting Concord's MCP connector listed

Where Concord's MCP server can be listed, what each listing needs, and who does what. Researched 2026-11-04; check each portal's current form before submitting, because they change often.

**Server URL:** `https://standards-concord.vercel.app/mcp` (Streamable HTTP, OAuth 2.1 per the MCP authorization spec: protected resource metadata, PKCE S256, dynamic client registration and client ID metadata documents). The source of truth for this address is [server.json](../server.json); change it with `node scripts/public-url.mjs https://<new-origin>`.

## Summary

| Where | How people install | Status | Survives a domain change? |
| --- | --- | --- | --- |
| Concord's own `/connect` page | *Add to Claude* button, steps for ChatGPT (custom MCP server), one-line commands for Claude Code and Codex, Cursor and VS Code links | Done | Yes: it always shows its own address |
| Claude Code plugin marketplace (this repo) | `/plugin marketplace add standards-concord/standards-concord`, then `/plugin install concord@concord` | Done | Partly: run the script and merge; installs move when they update (Claude Code leaves auto-update off for third-party marketplaces, so people run `/plugin marketplace update concord` or turn it on), then sign in again |
| Codex plugin marketplace (this repo) | `codex plugin marketplace add standards-concord/standards-concord`, then install from Plugins in the Codex app | Done | Partly, as above |
| Official MCP Registry | Discovered by MCP clients and directories that read the registry | Publishes from CI on merge | Yes: CI publishes a new version |
| GitHub MCP Registry (github.com/mcp) | One click into VS Code and other GitHub-connected clients | Needs an email from Jesse after the registry entry is live | Syncs from the official registry |
| Anthropic Connectors Directory (claude.ai) | Listed in Claude's connector directory | Needs Jesse to submit; needs a privacy policy and a reviewer account | No: email Anthropic to change the URL |
| OpenAI plugin directory (ChatGPT and Codex) | Listed in the Plugins directory of ChatGPT and the Codex app | Needs Jesse (identity verification); needs a privacy policy, terms and a demo video | No: contact OpenAI support to change the URL |
| Docker MCP Catalog, Glama, mcp.so, Cursor directory | Their own catalogues | Optional; details below | Varies |

**Before submitting to Anthropic or OpenAI, move to a stable domain** (for example a subdomain the ODI controls). Both tie the listing and its OAuth settings to the exact URL, and changing it means a support request each time. The official registry and the `/connect` page follow a move by themselves; plugin installs follow once they update. After any move, each agent signs in again, so keep the old domain working for a while.

## Official MCP Registry

- Entry: [server.json](../server.json), name `io.github.standards-concord/concord`, remote-only (no `packages`), schema `2025-12-11`.
- Publishing: [.github/workflows/mcp-registry.yml](../.github/workflows/mcp-registry.yml) runs `mcp-publisher login github-oidc` and `mcp-publisher publish` when `server.json` changes on `main` (or by hand from the Actions tab). GitHub's OIDC token proves the repo belongs to `standards-concord`, so no secret is needed.
- Moving domain: `node scripts/public-url.mjs https://<new-origin>` bumps the version (registry versions are immutable) and updates the plugins too. To retire an old version: `mcp-publisher status --status deprecated --message "Moved to <new URL>" io.github.standards-concord/concord <old version>`.
- Moving to the ODI's GitHub: an `org.theodi/...` or `io.github.theodi/...` name needs an org owner to publish; until then `io.github.standards-concord/concord` is fine.
- The registry is in preview, so its data may be reset.

## GitHub MCP Registry

Curated from the official registry. Once the official entry is live, email partnerships@github.com asking for `io.github.standards-concord/concord` to be included. Draft:

> Subject: MCP Registry listing: Concord (Open Data Institute)
>
> Hi, Concord is the Open Data Institute's platform for designing open data ontologies together. Its remote MCP server lets agents read the hub's OWL and LinkML ontologies, query them, check data against them and report gaps to the maintainers. It is published in the official MCP Registry as io.github.standards-concord/concord (https://standards-concord.vercel.app/mcp, OAuth with dynamic client registration). Could it be included in the GitHub MCP Registry? Thanks, Jesse

## Anthropic Connectors Directory

- Submit at https://claude.ai/directory/manage → Submit new → MCP connector (any paid Claude plan). Questions: mcp-review@anthropic.com. Terms: https://support.claude.com/en/articles/13145338, policy: https://support.claude.com/en/articles/13145358.
- What Concord already meets: HTTPS remote server; OAuth with discovery from a 401 `WWW-Authenticate` header; `resource` equals the server URL exactly; PKCE S256; dynamic client registration and client ID metadata documents (Anthropic prefers CIMD, which Claude uses by default); Claude's callback `https://claude.ai/api/mcp/auth_callback` and Claude Code's loopback callbacks on any port work, because redirect URIs come from each client's registration; every tool has a title and a read-only or destructive hint (checked by a test).
- Still needed from Jesse: a privacy policy URL (the ODI should own this), a support contact, an icon, a reviewer test account (demo sign-in works on the alpha, but a real Google or GitHub sign-in is better for review), and confirming it was tested as a custom connector (the *Add to Claude* button does this).
- Listing text:
  - **Name:** Concord
  - **Short description:** Read, query and check data against the ODI's open data ontologies, and report what's missing.
  - **Long description:** Concord is the Open Data Institute's platform for designing open data standards together. Connect it to Claude to look up terms in the hub's strict OWL ontologies, fetch them as Turtle, JSON-LD or LinkML for code generation, run SPARQL over them, and validate your own data against them. When a standard is missing a concept or doesn't fit your data, Claude can report it: Concord triages the report straight away (often the right terms already exist) and, where the standard should change, opens a change request that the community reviews under the standard's governance.
  - **Example prompts:** "Which terms in the volunteering ontology describe skills, and how are they related?"; "Generate pydantic models for the volunteering standard from its LinkML."; "Check this Turtle file against the volunteering ontology and tell me what doesn't fit."; "Our data records whether an opportunity reimburses travel. Is that in the standard? If not, report it."
  - **Documentation:** https://standards-concord.vercel.app/connect

## OpenAI plugin directory (ChatGPT and Codex)

- Submit at https://platform.openai.com/plugins → Submit for review. Guide: https://developers.openai.com/plugins/deploy/submission. Needs a verified individual or business identity.
- Domain verification: set `OPENAI_APPS_CHALLENGE` on the backend (via `deploy/azure/set-key.sh`) to the token OpenAI gives; Concord serves it at `/.well-known/openai-apps-challenge`.
- Also needed: website, support, privacy policy and terms URLs; a test account without MFA; five positive and three negative test cases; a short video walkthrough; release notes. The example prompts above work as positive cases. Negative cases: asking it to delete an ontology, to merge a change request without review, or to act on a private ontology the account can't see.
- Static bearer tokens are not accepted for listing, which is one reason for the OAuth work.
- What ChatGPT's connector needs from the OAuth server, all of which Concord does (covered by `apps/server/test/oauth.test.ts`):
  - Discovery: protected resource metadata with `resource` and `authorization_servers`, and authorization server metadata with S256 PKCE.
  - Registration: a client ID metadata document, or dynamic client registration (`none` or `client_secret_post`).
  - Which document and callback: because Concord doesn't advertise `authorization_response_iss_parameter_supported`, ChatGPT uses its callback-specific client ID `https://chatgpt.com/oauth/{callback_id}/client.json` with the callback `https://chatgpt.com/connector/oauth/{callback_id}`. The stable `https://chatgpt.com/oauth/client.json` (callback `https://chatgpt.com/connector_platform_oauth_redirect`) is only used with servers that advertise it. Both work: redirect URIs must exactly match the document.
  - Token authentication: ChatGPT's documents list the methods it can use (`none` and `private_key_jwt`). It picks from the overlap with Concord's metadata, which advertises `none` and `client_secret_post`, so it uses `none` with PKCE.
  - The `resource` parameter on both the authorization and token requests, and OIDC scopes on the authorization request.
  - Refresh tokens.
- Concord doesn't advertise `authorization_response_iss_parameter_supported`, even though its consent page returns `iss`, because some error redirects from the SDK don't include it.
- Client authentication rules Concord enforces (client ID metadata documents per draft-ietf-oauth-client-id-metadata-document-03):
  - A metadata-document client is accepted only if its document allows `none`. That means `none` is in `token_endpoint_auth_methods_supported`, or, if there is no list, `token_endpoint_auth_method` is `none` or absent. The list must be non-empty strings, the singular method must be in the list, and shared-secret methods are refused. A client that requires `private_key_jwt` is refused rather than downgraded.
  - At `/token` and `/revoke`, any credential Concord can't check gets `invalid_client` (401): `client_assertion` or `client_assertion_type`, an `Authorization` header (HTTP Basic), or a `client_secret` from a public client.
  - Registration accepts only `none` or `client_secret_post`. If the method is left out, Concord uses `client_secret_post` and says so in the response, because RFC 7591's default, `client_secret_basic`, isn't supported. Client secrets are stored only as SHA-256 hashes and compared in constant time. Whether a secret is needed follows the registered method, so a confidential client whose stored hash is missing or damaged is refused, never treated as public. Plain-text secrets from older versions are hashed at startup. The database then runs `VACUUM` and a truncating WAL checkpoint, so no old copy is left in free pages or the log. The scrub only counts as done once SQLite reports the checkpoint complete; if another connection blocks it, it stays owed and is retried in the background, backing off from 30 seconds up to an hour, and again at the next start. Each attempt gives up at once rather than waiting, so a blocked scrub never stalls requests. The database now runs with `secure_delete`. Backups taken before this still hold the old secrets, so treat those clients' secrets as exposed if a backup leaks. Secrets don't expire by default, but a `client_secret_expires_at` in the past is enforced. The checks cover every path the token and revocation endpoints answer. The OAuth endpoints only answer on their exact paths: near-misses such as `/token/`, `/TOKEN`, `//token` or `/token%2f` get 404 for every method, never the web app. To replace one, the client registers again and the person reconnects; disconnecting in Settings revokes the old tokens.
- The consent page only vouches for what Concord checked. A metadata-document client shows "Identified by" the host that served its document. A registered client's name and website are labelled as its own claims. Either way, the page prominently shows where access goes: the website host, an app on this computer (localhost), or, for a native app link, only its scheme, since the rest of such a link says nothing about who receives it.

## Other directories

- **Docker MCP Catalog:** open a pull request to https://github.com/docker/mcp-registry; `task remote-wizard` writes a `server.yaml` with `type: remote`, `remote.transport_type: streamable-http` and the URL.
- **Glama:** "Add Server" at https://glama.ai/mcp/servers; a `glama.json` in this repo claims the listing. It is said to import from the official registry.
- **PulseMCP:** imports from the official registry; nothing to do.
- **mcp.so:** form at https://mcp.so/submit (choose "Remote Server").
- **Cursor:** the curated marketplace is at https://cursor.com/marketplace/publish; the community directory (cursor.directory) takes a GitHub repo. The *Add to Cursor* button on `/connect` already works without a listing.
- **Smithery:** now part of Arcade and says its proxy shut down on 31 October, so skip it for now.

## Install links used on `/connect`

- Claude: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Concord&connectorUrl=<url>` opens the prefilled dialog. Connectors added there also appear in Claude Code when it is signed in with a Claude account.
- Claude Code: no deep link adds a server (`claude-cli://open` only prefills a prompt), so the page shows `claude mcp add --transport http concord <url>`.
- ChatGPT: no link prefills a custom MCP server, so the page shows the server URL to copy and opens `https://chatgpt.com/plugins`, where the person chooses *+* → *Add custom MCP server*, pastes the URL under *Connection*, picks OAuth and chooses *Create as a plugin*. They then install the new plugin (signing in to Concord when asked) and pick it with `@` in a chat. Some individual plans need Developer mode (Settings → Apps → Advanced) first, and workspace admins may have to allow custom servers. This is a private connection for that person, separate from the OpenAI directory listing below.
- Codex: no deep link exists; the page shows `codex mcp add concord --url <url>` and `codex mcp login concord`.
- Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=concord&config=<base64 {"url":...}>`.
- VS Code: `vscode:mcp/install?<url-encoded {"name":"concord","type":"http","url":...}>`.
