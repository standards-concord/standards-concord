# Concord

A prototype platform for designing data standards together, built for the Open Data Institute. Every standard is a strict OWL 2 ontology that is kept logically consistent and FAIR, and the whole lifecycle from a first conversation to a published release runs asynchronously, with AI help at each step.

- **Gather requirements three ways.** An AI interviewer follows Elisa Kendall's use case template and asks for competency questions with example answers. Google Meet transcripts can be uploaded, or a co-facilitator bot can join a live call and ask clarifying questions in chat. Coding agents such as Claude Code and Codex connect over MCP, read the ontology and report missing or ill-fitting concepts.
- **Turn requirements into changes.** Use cases are synthesised into a change request with structured edits and SPARQL tests for each competency question. The model never writes RDF directly: it proposes terms, and the server compiles them into validated edit operations.
- **Govern without meetings.** Every change is classified as patch, minor or major by explicit rules (based on OWL versioning practice and gist's semver approach), validated (strict lint, HermiT reasoner, FAIR checks, competency questions) and then reviewed under the ontology's governance policy. Policies come from a drop-down of five templates (steward-led, lazy consensus, W3C working group, membership vote, ODI-stewarded) and can be tuned: sign-off counts and roles, review periods, votes with quorum and threshold, vetoes, ODI privilege, ownership and transfer, and what is automated.
- **Release properly.** Releases take the highest level of their changes, bump the semantic version, stamp `owl:versionIRI`, `owl:priorVersion` and `owl:backwardCompatibleWith` or `owl:incompatibleWith`, and include every format plus a SPARQL migration script for major versions. Each ontology is a git repository (tag per release) that is pushed to GitHub on release when configured.
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

### Deploy (Vercel and AWS)

The web app is served by Vercel. Everything that needs a long-running server (the API, sign-in, the MCP endpoint, live meeting streams, the governance clock, the Solid server) runs on one small EC2 instance, launched from [deploy/aws/concord.yaml](deploy/aws/concord.yaml), which costs about $20 a month. Vercel forwards `/api`, `/auth`, `/mcp` and `/people` to it, so people only ever see the Vercel link. GitHub Actions tests every push and builds the backend image; the server picks up a new image within five minutes. Step by step: [docs/deploy.md](docs/deploy.md).

### Connect a coding agent

Create a token under *Agents* in any ontology, then:

```sh
claude mcp add --transport http concord https://<host>/mcp --header "Authorization: Bearer cnc_..."
```

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.concord]
url = "https://<host>/mcp"
bearer_token_env_var = "CONCORD_TOKEN"
```

Tools: `list_ontologies`, `get_ontology` (any format, including LinkML), `search_terms`, `get_term`, `sparql_query`, `validate_data`, `report_gap`, `propose_change`, `get_change_request`.

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
pnpm test
```

## Docs

- [Alpha walkthrough](docs/alpha-walkthrough.md)
- [Questions for ODI colleagues](docs/odi-questions.md)
- Research: [ontology practice, requirements, versioning and governance](docs/research/ontology-practice.md), [technical options](docs/research/tech.md), [ODI playbooks](docs/research/playbooks.md)
