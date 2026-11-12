# Coding agents, forks and app checks

## Connect a coding agent

Open `/connect` on any Concord site for install buttons. In short, with nothing but the URL:

```sh
claude mcp add --transport http concord https://standards-concord.vercel.app/mcp   # Claude Code, then /mcp → Authenticate
codex mcp add concord --url https://standards-concord.vercel.app/mcp && codex mcp login concord
```

In Claude (web, desktop, mobile, and Claude Code when signed in with a Claude account), the *Add to Claude* button opens the prefilled custom connector dialog. ChatGPT connects the same way, as a custom MCP server with OAuth (the page has the steps). The first connection opens a browser so the person signs in to Concord and clicks Allow: the MCP endpoint implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (OAuth 2.1 with PKCE, protected resource metadata, dynamic client registration and client ID metadata documents), so there is no token to copy. Personal tokens (on the same *Connect an agent* page, under the list of connected agents) remain for headless agents such as CI.

This repo is also a plugin marketplace for Claude Code (`/plugin marketplace add standards-concord/standards-concord`) and Codex (`codex plugin marketplace add standards-concord/standards-concord`), and `server.json` is its [MCP Registry](https://registry.modelcontextprotocol.io) entry. **When Concord moves domain**, run `node scripts/public-url.mjs https://<new-origin>` and merge: that updates every listing and republishes the registry entry. The site itself needs no change: every URL it shows and every OAuth endpoint is derived from the address it is served on (set `CONCORD_PROXY_SECRET` in Vercel and on the backend so the backend trusts the forwarded address; see [deploy.md](deploy.md)). Installed plugins follow when they update, and agents sign in again at the new address, so keep the old one working for a while. Listing details and what to submit where: [mcp-listings.md](mcp-listings.md).

## Ontology development skills

The plugin also ships three [Agent Skills](https://agentskills.io) in [`plugins/concord/skills`](../plugins/concord/skills), so an agent that installs it knows how to work on ontologies the way Concord checks them:

- [`ontology-term-drafting`](../plugins/concord/skills/ontology-term-drafting/SKILL.md): writing and reviewing terms (reuse first, naming, labels, genus–differentia definitions, placement, alignment, code lists, changing released terms).
- [`ontology-checking`](../plugins/concord/skills/ontology-checking/SKILL.md): the validation gate layer by layer (lint codes, OWL 2 DL reasoning with sparq, imports, FAIR, competency questions, derived SHACL, data validation, change impact).
- [`concord-change-governance`](../plugins/concord/skills/concord-change-governance/SKILL.md): taking part through Concord (the MCP tools, `report_gap` vs `propose_change` vs forks, following a change request, governance templates, reviewing, releases).

They are written from the rules in `packages/core` (lint, classifier, SHACL derivation), the modelling prompts in `apps/server/src/llm/prompts.ts`, the MCP tool descriptions and the governance templates. When one of those changes, update the matching skill. To use a skill without the plugin, upload its folder as a zip in Claude's settings (Capabilities → Skills).

## Development forks

Need a term the standard doesn't have yet? Fork it, add the term, and keep building while the change is reviewed. A fork is your own pre-release of the ontology:

- It resolves at `https://<host>/def/<ontology>/forks/<fork>` (content negotiated, Turtle unless the client asks for HTML, or by extension: `.ttl`, `.jsonld`, `.owl`, `.nt`, `.omn`, `.linkml.yaml`, `.shacl.ttl`), so applications can import it directly. It always serves the fork's latest revision, with CORS open.
- New terms keep the standard's namespace (`vol:VolunteeringActivity`, not a fork-specific IRI), so data written against the fork stays valid when the term lands. Moving back to the main ontology means changing the import URL.
- It is stamped as a pre-release: `owl:versionIRI` is the fork's URL, `owl:versionInfo` is like `1.0.0-fork.volunteer-hours.2`, and `owl:priorVersion` is the release it came from.
- Proposing the fork opens one change request with all its edits, which goes through the ontology's normal governance. Proposing again after more edits updates that request.
- Each fork is a git branch, `forks/<fork>`, in the ontology's repository; it never touches `main`. Every change to a fork (closing included) moves the branch with a compare-and-swap and saves the fork record with an atomic conditional write on its version; if the save loses, the commit is undone.
- Whether a change has landed is decided by content, three ways: for each term the fork touches, Concord compares what the fork's base, the fork, the working draft and the latest release say about it (ignoring provenance such as `dcterms:created`). A term counts as merged or released only when upstream has it exactly as the fork does, so a term renamed or reworded in review never triggers a migration.
- Syncing moves the fork onto the latest draft and replays only the edits that haven't landed. If upstream changed a term the fork also changes (directly, or through a change such as a removal reaching a term upstream added), or the result would be inconsistent, nothing changes and the conflicts are listed; discard the fork's change to take upstream's version, then sync and redo it if needed.
- Fork edits are checked for consistency with HermiT. With `CONCORD_REQUIRE_REASONER` on (the default when `NODE_ENV=production`), a fork change is refused if the reasoner can't run, rather than checked structurally only.
- Migration plans point to `/def/<ontology>/<version>` (or `/def/<ontology>/draft`), with the same extensions. Version IRIs give their HTML page to clients that don't ask for RDF, so code that fetches with no Accept header should switch to the `.ttl` URL; the plan says so.

In the app, forks are under *Changes → Forks*. Over MCP: `create_fork`, `edit_fork`, `propose_fork`, `check_forks`, `sync_fork`, `discard_fork_changes`, `list_forks`, `get_fork` and `close_fork`. Agents are told to call `check_forks` at the start of every development session: it says whether to keep using the fork, sync it, resolve conflicts, or switch to the draft or release, with the import URLs to replace.

## Test an app against proposed changes

Connect the app under *Changes → App checks* in any ontology, then add the [Concord app check action](../actions/app-check) to its CI. Results appear on each change request, and autopilot can approve or vote for you when your apps pass.
