# Deploying Concord

Concord runs in two parts:

- **Vercel** serves the web app, including the in-browser query engine (sparq, WebAssembly). A small routing middleware ([middleware.ts](../middleware.ts)) forwards `/api`, `/auth`, `/mcp`, `/people`, `/healthz` and the OAuth endpoints for MCP clients (`/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`) to the backend, with cookies, request bodies and streamed responses passed through. People and coding agents only ever use the Vercel link. When `CONCORD_PROXY_SECRET` is set (step 5), the middleware also tells the backend which domain the request came through and the visitor's IP address, vouched for by that secret, so the backend builds OAuth metadata and MCP URLs for that domain and rate-limits by the real visitor; adding a custom domain in Vercel then needs no backend change. Without the secret the backend ignores those headers and uses `PUBLIC_URL`.
- **One small VM** runs everything that needs a long-running server: the API, sign-in, the MCP endpoint for agents, live meeting streams and the Meet bot webhook, the governance clock (a tick every minute that closes review periods and votes, merges and drafts releases), git history for each ontology, the HermiT reasoner, and a Community Solid Server for private data. Caddy gives it HTTPS automatically. It runs on Azure, launched by one script, [deploy/azure/deploy.sh](../deploy/azure/deploy.sh). An AWS version is kept as an alternative (see the end of this page).

GitHub Actions ([ci.yml](../.github/workflows/ci.yml)) typechecks and tests every pull request and every push to `main`, then builds the backend image from `main` and pushes it to GitHub's container registry. The server checks for a new image every five minutes, so merging to `main` is the deploy. Vercel redeploys the web app by itself when a push to `main` changes the web app or the routing middleware. Other branches and pull requests get no Vercel build (the free plan allows 100 deployments a day, and CI already tests the production build); `git.deploymentEnabled` and `ignoreCommand` in [vercel.json](../vercel.json) set this. [ci.md](ci.md) explains what runs when, and how to keep within the free minutes; [moving-accounts.md](moving-accounts.md) covers moving to a dedicated GitHub organisation and Vercel account.

## Cost

The default VM size, `Standard_B2ats_v2` (2 vCPU, 1 GB of RAM plus 4 GB of swap), is one of the sizes that Azure for Students gives 750 free hours a month of for the first 12 months, along with the 64 GB SSD. What is left to pay from the student credit is the static public IP address and the daily snapshots, a few dollars a month. Vercel's free Hobby plan is enough for an alpha. Claude API usage is billed separately.

If the server is slow during reasoning checks, move it to `Standard_B2als_v2` (4 GB of RAM), which is billed against the credit: `az vm resize -g concord -n concord --size Standard_B2als_v2`. When the credit runs out, Azure disables the subscription unless it is upgraded to pay-as-you-go.

## Steps

1. **Build the backend image.** Merge to `main`. The CI workflow's `image` job publishes `ghcr.io/standards-concord/standards-concord:latest`, which is public, so the server needs no token to pull it.

2. **Create the Vercel project.** In Vercel, Add New, Project, and import `standards-concord/standards-concord`. Leave the root directory as the repository root; the build settings come from [vercel.json](../vercel.json). Until step 4 is done, API calls return a message saying `BACKEND_URL` is missing.

3. **Launch the backend.** On a machine with the Azure CLI, sign in with `az login`, then from the repository run:

   ```sh
   PUBLIC_URL=https://standards-concord.vercel.app ADMIN_EMAILS=you@example.org ./deploy/azure/deploy.sh
   ```

   It creates a resource group `concord` in UK South with the VM, a static IP address and a firewall that only opens ports 80 and 443, and prints the `BackendUrl` (for example `https://203.0.113.10.sslip.io`). `LOCATION`, `RESOURCE_GROUP` and `VM_SIZE` can be set the same way if a student subscription does not allow UK South. The server takes a few minutes to start and get its certificate.

4. **Connect the two.** In Vercel, Settings, Environment Variables, add `BACKEND_URL` with the `BackendUrl` value for Production and Preview, then redeploy from the Deployments tab.

5. **Link the proxy and the backend with a secret.** Generate one with `openssl rand -hex 32`. Add it in Vercel as `CONCORD_PROXY_SECRET` (Production and Preview) and redeploy **first**, then run `./deploy/azure/set-key.sh CONCORD_PROXY_SECRET` and paste the same value. The backend only believes the forwarded domain and visitor IP from requests carrying it, so people calling the backend directly can't pick which domain its OAuth URLs use or dodge the sign-in rate limits. Once the backend has the secret, it refuses OAuth and MCP requests (HTTP 421) that neither carry it nor are addressed to a domain in `PUBLIC_URL`, `WEB_URL` or `PUBLIC_ORIGINS`, which is why Vercel needs it before the backend does. Without it, everything still works for `PUBLIC_URL`: any other host name (including the backend's own, which is what Vercel's forwarded requests carry) is treated as an alias of `PUBLIC_URL`, other Vercel domains (previews, a new custom domain) show OAuth URLs for `PUBLIC_URL`, and every agent counts as one visitor for rate limiting.

6. **Add the Claude key.** `./deploy/azure/set-key.sh ANTHROPIC_API_KEY` asks for the value without showing it, so the interviewer, triage, meeting analysis, persona simulation and feedback chat use Claude.

7. **Check it.** `./deploy/smoke.sh https://<vercel-url>` signs in as a demo tester and exercises the API, HermiT validation, SPARQL, an interview, a change request and the MCP endpoint through Vercel. Then send testers `https://<vercel-url>/alpha`.

## Adding keys later

Keys live in `/opt/concord/keys.env` on the server. `./deploy/azure/set-key.sh NAME` adds or changes one; the server applies it within five minutes.

| Key | What it turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude for the interviewer, triage, meeting analysis, persona simulation and feedback chat. Without it these use an offline stand-in. |
| `CONCORD_PROXY_SECRET` | Must equal the Vercel variable of the same name (step 5). Lets the backend trust the domain and visitor IP the Vercel middleware forwards. |
| `PUBLIC_ORIGINS` | Comma-separated extra origins, such as a domain pointed straight at the backend, that may appear in OAuth metadata and MCP URLs when reached directly. Vercel domains don't need listing when `CONCORD_PROXY_SECRET` is set. |
| `TRUST_PROXY` | Which proxies' `X-Forwarded-*` headers to believe, in [Express's syntax](https://expressjs.com/en/guide/behind-proxies.html). The default, `loopback, linklocal, uniquelocal`, covers Caddy on the same Docker network. OAuth URLs never come from these headers. |
| `OPENAI_APPS_CHALLENGE` | The domain verification token from OpenAI's plugin submission, served at `/.well-known/openai-apps-challenge`. |
| `ADMIN_EMAILS` | Comma-separated emails that can reset the demo and read every tester's feedback once signed in with Google or GitHub. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Create an OAuth client (Web application) in Google Cloud with redirect URI `<vercel-url>/auth/google/callback`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. Create an OAuth app with callback URL `<vercel-url>/auth/github/callback`. |
| `GITHUB_PUBLISH_TOKEN`, `GITHUB_PUBLISH_OWNER` | Push each ontology's git history and release tags to a GitHub repository on release. |
| `FEEDBACK_GITHUB_TOKEN` | Lets testers opt in to posting a short summary of their feedback as a GitHub issue (see [public feedback summaries](feedback-issues.md)). A fine-grained token for this one repository with **Issues: Read and write**. Optional: `FEEDBACK_GITHUB_REPO` (default `standards-concord/standards-concord`), `FEEDBACK_ISSUES_PER_HOUR` (default 10, rolling, shared by all server processes), `FEEDBACK_TRIAGE_TOKEN` (a long random secret the triage routine sends to the server's triage endpoints; without it they're off). |
| `RECALL_API_KEY` | The live Google Meet co-facilitator bot (Recall.ai). Its webhook comes in through Vercel. |
| `OPENAI_API_KEY` with `STT_PROVIDER=openai` | Voice feedback in browsers without built-in speech recognition (Firefox). |
| `DEMO_MODE`, `ALLOW_PUBLIC_RESET` | Demo sign-in and the simulated working group (on by default); whether any tester can reset the shared demo (off). |
| `GHCR_USER`, `GHCR_TOKEN` | Only if the image is made private again: a token with `read:packages`. |

## Running the server

- **Shell access:** there is no SSH port. `az vm run-command invoke -g concord -n concord --command-id RunShellScript --scripts "cd /opt/concord && docker compose --env-file stack.env logs --tail 100 concord"` shows the logs; any other command works the same way.
- **Deploy now** instead of waiting five minutes: run `systemctl start concord-refresh.service` the same way.
- **Backups:** the disk is snapshotted daily at 03:00 UTC (incremental snapshots named `concord-YYYYMMDD` in the resource group), and snapshots older than 14 days are deleted. The disk holds the database, every ontology's git history and the Solid pods.
- **Your own domain:** point DNS A records for the hostname and `pods.` under it at the static IP, change `HOST` in `/opt/concord/stack.env`, restart the stack, and change `BACKEND_URL` in Vercel.
- **Moving Concord's public address** (the domain people and agents use): add the domain in Vercel, set `PUBLIC_URL` to it with `set-key.sh`, run `node scripts/public-url.mjs https://<new-origin>` and merge so the plugins and MCP Registry entry follow. Keep the old domain serving Concord for a few weeks: installed plugins only move when they update, and every agent has to sign in again at the new address, because OAuth tokens are tied to the address they were issued for.
- **Removing it:** `az group delete -n concord` deletes the VM, its IP address, disk and snapshots.

## Alternative: AWS

[deploy/aws/concord.yaml](../deploy/aws/concord.yaml) is a CloudFormation template for the same server on a t3.small EC2 instance (about $20 a month), with keys in Secrets Manager. Upload it in CloudFormation, set `PublicUrl` and any keys, and use its `BackendUrl` output as above.

## Why the backend is a server

The ontology is also available in the browser: the Query tab loads it into sparq and runs SPARQL and SHACL checks locally. The rest needs a server that stays up:

- **Agents** connect to `/mcp` from their own machines, signing in with OAuth, and their gap reports open change requests that everyone sees.
- **Live meetings** need a webhook that Recall.ai calls as people speak, and a stream that pushes the co-facilitator's prompts to everyone watching.
- **The governance clock** has to run when nobody has the site open, so review periods end and votes close on time.
- **Full OWL DL reasoning** uses HermiT. sparq's WebAssembly build covers RDFS and OWL 2 RL, and its DL reasoner covers ALCH, which is not enough for the qualified cardinality restrictions and functional properties the standards use. When sparq's DL reasoner covers OWL 2 DL, consistency checks can move into the browser as well.
- **Private data** goes into Solid pods on the bundled Community Solid Server, and each ontology's history lives in git.
