# Run, test and deploy Concord

## Run it

Requires Node 22.13+ and pnpm 10. Git must be on the PATH.

```sh
pnpm install
pnpm dev            # API on :8787, web app on :5173
```

Open http://localhost:5173/alpha. With no configuration it runs entirely offline: the AI steps use deterministic fallbacks, private data is stored on local disk, and sign-in is by demo account.

OWL 2 DL reasoning (consistency, unsatisfiable classes, the inferred hierarchy) runs on [sparq](https://github.com/sparq-org/sparq) compiled to WebAssembly, the same code on the server (in a worker thread) and in the browser (in a Web Worker), so there is nothing extra to install. sparq decides most of OWL 2 DL. When it can't decide an ontology, or runs out of its step budget, it says so, and validation doesn't pass until it can. `./toolkit/setup.sh` only installs LinkML, which one of the core tests uses.

To use Claude, set `ANTHROPIC_API_KEY` (see [.env.example](../.env.example) for every setting). The default model is `claude-opus-5-5`.

## Docker

```sh
cp .env.example .env
docker compose up --build   # Concord on :8787, Community Solid Server on :3000
```

## Deploy (Vercel and Azure)

The web app is served by Vercel. Everything that needs a long-running server (the API, sign-in, the MCP endpoint, live meeting streams, the governance clock, the Solid server) runs on one small Azure VM, launched by [deploy/azure/deploy.sh](../deploy/azure/deploy.sh), which fits Azure for Students' free tier (an AWS template is kept as an alternative). Vercel forwards `/api`, `/auth`, `/mcp`, `/people` and the OAuth endpoints for MCP clients to it, so people only ever see the Vercel link. GitHub Actions tests every push and builds the backend image; the server picks up a new image within five minutes. Step by step: [deploy.md](deploy.md).

## Optional services

| Feature | Configure |
| --- | --- |
| Sign in with Google / GitHub | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` |
| Solid pods for private data | `SOLID_SERVER_URL` (Community Solid Server v7+) |
| Live Google Meet bot | `RECALL_API_KEY` (Recall.ai). The Google Meet Media API is still a closed preview. Add `MEET_BOT_EMAIL` and `MEET_BOT_ICS_URL` so inviting the bot's address to a call (or a recurring series) brings it in: [meet-bot.md](meet-bot.md). |
| Publish releases to GitHub | `GITHUB_PUBLISH_TOKEN`, and set the repository on the ontology |
| Opt-in public feedback summaries as GitHub issues | `FEEDBACK_GITHUB_TOKEN` (Issues: read and write). See [feedback-issues.md](feedback-issues.md) |
| Voice input on Firefox | `STT_PROVIDER=openai`, `OPENAI_API_KEY` |

## Layout

```
packages/core     OWL engine: parsing, edit operations, diff, change classification, versioning,
                  lint, FAIR checks, reasoners, competency-question tests, LinkML/Manchester/SHACL
packages/shared   Domain types and the HTTP API contract
apps/server       Express API, MCP endpoint, governance engine, AI prompts, Solid, meeting bot
apps/web          React app
toolkit           Python virtualenv with LinkML, used by tests
docs              How-tos, research and the alpha walkthrough script
```

## Tests

```sh
pnpm test            # unit and API tests
pnpm test:e2e        # browser tests (Playwright): the alpha walkthrough and every page
pnpm test:e2e:live   # read-only smoke tests against the deployed site (LIVE_URL)
```

The browser tests start their own API server (on port 8797, with a throwaway data directory) and web app (port 5183), so they don't disturb a running `pnpm dev`. Set `E2E_MODE=preview` to test the production build instead of the dev server; run `pnpm --filter @concord/web build` first. CI runs both modes on every push, and the live tests after every Vercel production deploy. Add new specs as `e2e/<feature>.spec.ts`, using the `test` from `e2e/fixtures.ts`: it fails any test whose page logs a console error or crashes.

Every feature comes with Playwright tests, and **every bug fix comes with a Playwright test that reproduces the bug**, so it can't come back. [docs/e2e-coverage.md](e2e-coverage.md) maps each page, role and flow to the spec that covers it. More in [CLAUDE.md](../CLAUDE.md).

## More docs

- [What Concord does](features.md)
- [Connect a coding agent, development forks and app checks](agents.md)
- [CI and deploy budgets](ci.md), [deploying](deploy.md), [browser test coverage](e2e-coverage.md)
- [Alpha walkthrough](alpha-walkthrough.md)
- [Narrated walkthrough video](../walkthrough/README.md): `pnpm walkthrough` records it from an editable script
- Research: [ontology practice, requirements, versioning and governance](research/ontology-practice.md), [visual views of an ontology](research/ontology-visualisation.md), [technical options](research/tech.md), [ODI playbooks](research/playbooks.md)
## Licence

Concord is open source under the [MIT licence](../LICENSE). The vendored packages in `packages/pod-auth` and `packages/suite-ui` carry their own MIT licences. The Open Data Institute's name and logo (used by the `odi` look) and the third-party logos listed in [third-party-marks.md](third-party-marks.md) are trademarks of their owners and aren't covered by the licence. A fork should pick one of the unbranded looks.
