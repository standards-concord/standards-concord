# Concord

A prototype platform for designing data standards together, built for the Open Data Institute. Every standard is a strict OWL 2 ontology that is kept logically consistent and FAIR, and the whole lifecycle from a first conversation to a published release runs asynchronously, with AI help at each step.

- **Gather requirements three ways.** An AI interviewer follows Elisa Kendall's use case template and asks for competency questions with example answers. Google Meet transcripts can be uploaded, or a co-facilitator bot can join a live call, invited by email like any other guest, and raise clarifying questions (in the Meet chat, if you want). Coding agents such as Claude Code and Codex connect over MCP, read the ontology and report missing or ill-fitting concepts.
- **Turn requirements into changes.** Use cases are synthesised into a change request with structured edits and SPARQL tests for each competency question. The model never writes RDF directly: it proposes terms, and the server compiles them into validated edit operations.
- **Edit terms where you read them.** Each term in Browse has an Edit button for its label, definition, comment, alternative labels, examples and editorial note, next to Report a problem. An edit becomes an editorial change request (one `updateAnnotations` edit), so it is classified, validated and approved like any other change; nothing reaches the working draft until it merges. The edit records the values it started from, so if another change to the same field merges first it goes back to its author instead of overwriting it, and rewording a definition asks whether the meaning is kept (a change of meaning is reviewed as major).
- **Govern without meetings.** Every change is classified as patch, minor or major by explicit rules (based on OWL versioning practice and gist's semver approach), validated (strict lint, OWL 2 DL reasoning with sparq, FAIR checks, competency questions) and then reviewed under the ontology's governance policy. Policies come from a drop-down of five templates (steward-led, lazy consensus, W3C working group, membership vote, ODI-stewarded) and can be tuned: sign-off counts and roles, review periods, votes with quorum and threshold, vetoes, ODI privilege, ownership and transfer, and what is automated.
- **Release properly.** Releases take the highest level of their changes, bump the semantic version, stamp `owl:versionIRI`, `owl:priorVersion` and `owl:backwardCompatibleWith` or `owl:incompatibleWith`, and include every format plus a SPARQL migration script for major versions. Each ontology is a git repository (tag per release) that is pushed to GitHub on release when configured.
- **Readable at its own address.** The ontology IRI and every version IRI resolve to a public page in the style of W3C and Widoco vocabulary docs: metadata, a reference entry for every term (anchored by its IRI fragment), the use cases and requirements behind the version, release notes and every serialisation. RDF clients get Turtle, JSON-LD, RDF/XML or N-Triples from the same address by content negotiation, or by extension (`/def/<slug>/<version>.ttl`). The page is also written into each release as `index.html`, and w3id.org redirect rules are generated for persistent IRIs.
- **Validate data against it.** Paste or upload RDF on an ontology's *Validate data* page, or POST it to the ontology or version address (`curl -X POST https://<site>/def/<slug>/<version> -H 'Content-Type: text/turtle' --data-binary @data.ttl`). The data is checked against the SHACL shapes derived from that version and against the terms it defines, and the answer is a JSON report or, with `Accept: text/turtle`, a SHACL `sh:ValidationReport` (listing the first 1,000 results; the summary counts them all). Turtle, JSON-LD, N-Triples, N-Quads, TriG and RDF/XML are accepted, up to 5 MB (JSON-LD 2 MB) or 25,000 distinct triples (holding at most 8 million characters of IRIs and literals, with IRIs up to 4,096 characters), two at a time and 30 requests a minute per client. The shapes themselves come back from the same address for the SHACL profile (`Accept-Profile: <http://www.w3.org/ns/shacl#>` or `?_profile=shacl`). Agents get the same check from the MCP `validate_data` tool.
- **Query it in the browser.** The Query tab loads the ontology into [sparq](https://github.com/sparq-org/sparq), a SPARQL engine compiled to WebAssembly, to run SPARQL and check instance data against the ontology's SHACL shapes without a round trip to the server.
- **See it, not just read it.** The Browse tab has an accessible class tree with schema.org-style property tables, a UML-style class diagram (attributes, relationships with cardinalities, subclasses) and a network graph. See [ontology visualisation](docs/research/ontology-visualisation.md).
- **View it your way.** Turtle, LinkML, JSON-LD, RDF/XML, N-Triples, Manchester syntax and SHACL shapes, also in the much more readable SHACL compact syntax (SHACLC).
- **Use it in code straight away.** Every SHACL shape is also a JavaScript class, generated with the [ODI SHACL converter](https://github.com/theodi/shacl-shape-converter-typescript) over [@rdfjs/wrapper](https://github.com/rdfjs/wrapper). Apps import them from the ontology's own address (`import { VolunteeringDataset } from "https://…/def/volunteering/1.0.0.js"`, or `Accept: text/javascript`), get types from `.d.ts`, or `npm install https://…/def/volunteering/1.0.0.tgz`. The package name is the same for every version and fork, so moving an app from a fork to a release only changes that URL.
- **Identity and private data.** Sign in with Google or GitHub. A WebID and a Solid pod are created automatically; private material such as interview transcripts is stored in the pod, and only the structured, public parts are shared.
- **Alpha testing built in.** `/alpha` walks testers through the platform in a role of their choice with a simulated working group around them, and `/feedback` is a voice-enabled feedback chat with guided and open pathways.

## Run it

Requires Node 22.13+ and pnpm 10. Git must be on the PATH.

```sh
pnpm install
pnpm dev            # API on :8787, web app on :5173
```

Open http://localhost:5173/alpha. With no configuration it runs entirely offline: the AI steps use deterministic fallbacks, private data is stored on local disk, and sign-in is by demo account.

OWL 2 DL reasoning (consistency, unsatisfiable classes, the inferred hierarchy) runs on [sparq](https://github.com/sparq-org/sparq) compiled to WebAssembly, the same code on the server (in a worker thread) and in the browser (in a Web Worker), so there is nothing extra to install. sparq decides most of OWL 2 DL. When it can't decide an ontology, or runs out of its step budget, it says so, and validation doesn't pass until it can. `./toolkit/setup.sh` only installs LinkML, which one of the core tests uses.

To use Claude, set `ANTHROPIC_API_KEY` (see [.env.example](.env.example) for every setting). The default model is `claude-opus-5-5`.

### Docker

```sh
cp .env.example .env
docker compose up --build   # Concord on :8787, Community Solid Server on :3000
```

### Deploy (Vercel and Azure)

The web app is served by Vercel. Everything that needs a long-running server (the API, sign-in, the MCP endpoint, live meeting streams, the governance clock, the Solid server) runs on one small Azure VM, launched by [deploy/azure/deploy.sh](deploy/azure/deploy.sh), which fits Azure for Students' free tier (an AWS template is kept as an alternative). Vercel forwards `/api`, `/auth`, `/mcp`, `/people` and the OAuth endpoints for MCP clients to it, so people only ever see the Vercel link. GitHub Actions tests every push and builds the backend image; the server picks up a new image within five minutes. Step by step: [docs/deploy.md](docs/deploy.md).

### Connect a coding agent

Open `/connect` on any Concord site for install buttons. In short, with nothing but the URL:

```sh
claude mcp add --transport http concord https://standards-concord.vercel.app/mcp   # Claude Code, then /mcp → Authenticate
codex mcp add concord --url https://standards-concord.vercel.app/mcp && codex mcp login concord
```

In Claude (web, desktop, mobile, and Claude Code when signed in with a Claude account), the *Add to Claude* button opens the prefilled custom connector dialog. ChatGPT connects the same way, as a custom MCP server with OAuth (the page has the steps). The first connection opens a browser so the person signs in to Concord and clicks Allow: the MCP endpoint implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (OAuth 2.1 with PKCE, protected resource metadata, dynamic client registration and client ID metadata documents), so there is no token to copy. Personal tokens (Settings) remain for headless agents such as CI.

This repo is also a plugin marketplace for Claude Code (`/plugin marketplace add standards-concord/standards-concord`) and Codex (`codex plugin marketplace add standards-concord/standards-concord`), and `server.json` is its [MCP Registry](https://registry.modelcontextprotocol.io) entry. **When Concord moves domain**, run `node scripts/public-url.mjs https://<new-origin>` and merge: that updates every listing and republishes the registry entry. The site itself needs no change: every URL it shows and every OAuth endpoint is derived from the address it is served on (set `CONCORD_PROXY_SECRET` in Vercel and on the backend so the backend trusts the forwarded address; see [docs/deploy.md](docs/deploy.md)). Installed plugins follow when they update, and agents sign in again at the new address, so keep the old one working for a while. Listing details and what to submit where: [docs/mcp-listings.md](docs/mcp-listings.md).

### Optional services

| Feature | Configure |
| --- | --- |
| Sign in with Google / GitHub | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` |
| Solid pods for private data | `SOLID_SERVER_URL` (Community Solid Server v7+) |
| Live Google Meet bot | `RECALL_API_KEY` (Recall.ai). The Google Meet Media API is still a closed preview. Add `MEET_BOT_EMAIL` and `MEET_BOT_ICS_URL` so inviting the bot's address to a call (or a recurring series) brings it in: [docs/meet-bot.md](docs/meet-bot.md). |
| Publish releases to GitHub | `GITHUB_PUBLISH_TOKEN`, and set the repository on the ontology |
| Opt-in public feedback summaries as GitHub issues | `FEEDBACK_GITHUB_TOKEN` (Issues: read and write). See [docs/feedback-issues.md](docs/feedback-issues.md) |
| Voice input on Firefox | `STT_PROVIDER=openai`, `OPENAI_API_KEY` |

## Layout

```
packages/core     OWL engine: parsing, edit operations, diff, change classification, versioning,
                  lint, FAIR checks, reasoners, competency-question tests, LinkML/Manchester/SHACL
packages/shared   Domain types and the HTTP API contract
apps/server       Express API, MCP endpoint, governance engine, AI prompts, Solid, meeting bot
apps/web          React app
toolkit           Python virtualenv with LinkML, used by tests
docs              Research, the alpha walkthrough script and questions for ODI colleagues
```

## Tests

```sh
pnpm test            # unit and API tests
pnpm test:e2e        # browser tests (Playwright): the alpha walkthrough and every page
pnpm test:e2e:live   # read-only smoke tests against the deployed site (LIVE_URL)
```

The browser tests start their own API server (on port 8797, with a throwaway data directory) and web app (port 5183), so they don't disturb a running `pnpm dev`. Set `E2E_MODE=preview` to test the production build instead of the dev server; run `pnpm --filter @concord/web build` first. CI runs both modes on every push, and the live tests after every Vercel production deploy. Add new specs as `e2e/<feature>.spec.ts`, using the `test` from `e2e/fixtures.ts`: it fails any test whose page logs a console error or crashes.

Every feature comes with Playwright tests, and **every bug fix comes with a Playwright test that reproduces the bug**, so it can't come back. [docs/e2e-coverage.md](docs/e2e-coverage.md) maps each page, role and flow to the spec that covers it. More in [CLAUDE.md](CLAUDE.md).

## Docs

- [Alpha walkthrough](docs/alpha-walkthrough.md)
- [Narrated walkthrough video](walkthrough/README.md): `pnpm walkthrough` records it from an editable script
- [Questions for ODI colleagues](docs/odi-questions.md)
- Research: [ontology practice, requirements, versioning and governance](docs/research/ontology-practice.md), [visual views of an ontology](docs/research/ontology-visualisation.md), [technical options](docs/research/tech.md), [ODI playbooks](docs/research/playbooks.md)
