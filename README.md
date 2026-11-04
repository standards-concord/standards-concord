# Concord

A prototype platform for designing data standards together, built for the Open Data Institute. Every standard is a strict OWL 2 ontology that is kept logically consistent and FAIR, and the whole lifecycle from a first conversation to a published release runs asynchronously, with AI help at each step.

- **Gather requirements three ways.** An AI interviewer works through a structured use case and asks for competency questions with example answers. Google Meet transcripts can be uploaded, or a co-facilitator bot can join a live call and ask clarifying questions in chat. Coding agents such as Claude Code and Codex connect over MCP, read the ontology and report missing or ill-fitting concepts.
- **Turn requirements into changes.** Use cases are synthesised into a change request with structured edits and SPARQL tests for each competency question. The model never writes RDF directly: it proposes terms, and the server compiles them into validated edit operations.
- **Govern without meetings.** Every change is classified as patch, minor or major by explicit rules (based on OWL versioning practice and gist's semver approach), validated (strict lint, HermiT reasoner, FAIR checks, competency questions) and then reviewed under the ontology's governance policy. Policies come from a drop-down of five templates (steward-led, lazy consensus, W3C working group, membership vote, ODI-stewarded) and can be tuned: sign-off counts and roles, review periods, votes with quorum and threshold, vetoes, ODI privilege, ownership and transfer, and what is automated.
- **Release properly.** Releases take the highest level of their changes, bump the semantic version, stamp `owl:versionIRI`, `owl:priorVersion` and `owl:backwardCompatibleWith` or `owl:incompatibleWith`, and include every format plus a SPARQL migration script for major versions. Each ontology is a git repository (tag per release) that is pushed to GitHub on release when configured.
- **Readable at its own address.** The ontology IRI and every version IRI resolve to a public page in the style of W3C and Widoco vocabulary docs: metadata, a reference entry for every term (anchored by its IRI fragment), the use cases and requirements behind the version, release notes and every serialisation. RDF clients get Turtle, JSON-LD, RDF/XML or N-Triples from the same address by content negotiation, or by extension (`/def/<slug>/<version>.ttl`). The page is also written into each release as `index.html`, and w3id.org redirect rules are generated for persistent IRIs.
- **Query it in the browser.** The Query tab loads the ontology into [sparq](https://github.com/sparq-org/sparq), a SPARQL engine compiled to WebAssembly, to run SPARQL and check instance data against the ontology's SHACL shapes without a round trip to the server.
- **View it your way.** Turtle, LinkML (used inside the ODI), JSON-LD, RDF/XML, N-Triples, Manchester syntax and SHACL shapes.
- **Identity and private data.** Sign in with Google or GitHub. A WebID and a Solid pod are created automatically; private material such as interview transcripts is stored in the pod, and only the structured, public parts are shared.
- **Alpha testing built in.** `/alpha` walks testers through the platform in a role of their choice with a simulated working group around them, and `/feedback` is a voice-enabled feedback chat with guided and open pathways.

## Run it

Requires Node 22.13+ and pnpm 10. Git must be on the PATH.

```sh
pnpm install
pnpm dev            # API on :8787, web app on :5173
```

Open http://localhost:5173/alpha. With no configuration it runs entirely offline: the AI steps use deterministic fallbacks, private data is stored on local disk, and sign-in is by demo account.

For full OWL DL reasoning (HermiT), install Java 11+ and run `./toolkit/setup.sh`. Without it, a built-in structural reasoner is used.

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

In Claude (web, desktop, mobile, and Claude Code when signed in with a Claude account), the *Add to Claude* button opens the prefilled custom connector dialog. The first connection opens a browser so the person signs in to Concord and clicks Allow: the MCP endpoint implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (OAuth 2.1 with PKCE, protected resource metadata, dynamic client registration and client ID metadata documents), so there is no token to copy. Personal tokens (Settings) remain for headless agents such as CI.

This repo is also a plugin marketplace for Claude Code (`/plugin marketplace add jeswr/standards-concord`) and Codex (`codex plugin marketplace add jeswr/standards-concord`), and `server.json` is its [MCP Registry](https://registry.modelcontextprotocol.io) entry. **When Concord moves domain**, run `node scripts/public-url.mjs https://<new-origin>` and merge: that updates every listing and republishes the registry entry. The site itself needs no change: every URL it shows and every OAuth endpoint is derived from the address it is served on (set `CONCORD_PROXY_SECRET` in Vercel and on the backend so the backend trusts the forwarded address; see [docs/deploy.md](docs/deploy.md)). Installed plugins follow when they update, and agents sign in again at the new address, so keep the old one working for a while. Listing details and what to submit where: [docs/mcp-listings.md](docs/mcp-listings.md).

### Optional services

| Feature | Configure |
| --- | --- |
| Sign in with Google / GitHub | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` |
| Solid pods for private data | `SOLID_SERVER_URL` (Community Solid Server v7+) |
| Live Google Meet bot | `RECALL_API_KEY` (Recall.ai). The Google Meet Media API is still a closed preview. |
| Publish releases to GitHub | `GITHUB_PUBLISH_TOKEN`, and set the repository on the ontology |
| Voice input on Firefox | `STT_PROVIDER=openai`, `OPENAI_API_KEY` |

## Layout

```
packages/core     OWL engine: parsing, edit operations, diff, change classification, versioning,
                  lint, FAIR checks, reasoners, competency-question tests, LinkML/Manchester/SHACL
packages/shared   Domain types and the HTTP API contract
apps/server       Express API, MCP endpoint, governance engine, AI prompts, Solid, meeting bot
apps/web          React app
toolkit           Python helper for HermiT/Pellet reasoning (owlready2)
docs              Research, the alpha walkthrough script and questions for ODI colleagues
```

## Tests

```sh
pnpm test            # unit and API tests
pnpm test:e2e        # browser tests (Playwright): the alpha walkthrough and every page
pnpm test:e2e:live   # read-only smoke tests against the deployed site (LIVE_URL)
```

The browser tests start their own API server (on port 8797, with a throwaway data directory) and web app (port 5183), so they don't disturb a running `pnpm dev`. Set `E2E_MODE=preview` to test the production build instead of the dev server; run `pnpm --filter @concord/web build` first. CI runs both modes on every push, and the live tests after every Vercel production deploy. Add new specs as `e2e/<feature>.spec.ts`, using the `test` from `e2e/fixtures.ts`: it fails any test whose page logs a console error or crashes.

## Docs

- [Alpha walkthrough](docs/alpha-walkthrough.md)
- [Narrated walkthrough video](walkthrough/README.md): `pnpm walkthrough` records it from an editable script
- [Questions for ODI colleagues](docs/odi-questions.md)
- Research: [ontology practice, requirements, versioning and governance](docs/research/ontology-practice.md), [technical options](docs/research/tech.md), [ODI playbooks](docs/research/playbooks.md)
