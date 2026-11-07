# Deploying Concord

Concord runs in two parts:

- **Vercel** serves the web app, including the in-browser query engine (sparq, WebAssembly). A small routing middleware ([middleware.ts](../middleware.ts)) forwards `/api`, `/auth`, `/mcp`, `/people`, `/healthz` and the OAuth endpoints for MCP clients (`/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`) to the backend, with cookies, request bodies and streamed responses passed through. People and coding agents only ever use the Vercel link. When `CONCORD_PROXY_SECRET` is set (step 5), the middleware also tells the backend which domain the request came through and the visitor's IP address, vouched for by that secret, so the backend builds OAuth metadata and MCP URLs for that domain and rate-limits by the real visitor; adding a custom domain in Vercel then needs no backend change. Without the secret the backend ignores those headers and uses `PUBLIC_URL`.
- **One small VM** runs everything that needs a long-running server: the API, sign-in, the MCP endpoint for agents, live meeting streams and the Meet bot webhook, the governance clock (a tick every minute that closes review periods and votes, merges and drafts releases), git history for each ontology, and a Community Solid Server for private data. Caddy gives it HTTPS automatically. It runs on Azure, launched by one script, [deploy/azure/deploy.sh](../deploy/azure/deploy.sh). An AWS version is kept as an alternative (see the end of this page).

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

7. **Check it.** `./deploy/smoke.sh https://<vercel-url>` signs in as a demo tester and exercises the API, validation with the OWL reasoner, SPARQL, an interview, a change request and the MCP endpoint through Vercel. Then send testers `https://<vercel-url>/alpha`.

## Adding keys later

Keys live in `/opt/concord/keys.env` on the server. `./deploy/azure/set-key.sh NAME` adds or changes one; the server applies it within five minutes. To run it from any folder without a checkout (needs `gh` and `az` signed in): `setkey() { local r=standards-concord/standards-concord; bash <(gh api -H 'Accept: application/vnd.github.raw' "repos/$r/contents/deploy/azure/set-key.sh") "$@"; }`, then `setkey NAME`. It asks for the value without showing it (or reads it from a pipe, e.g. `pbpaste | ./deploy/azure/set-key.sh NAME`) and never puts it in a command line: `az` reads it from a private temporary file that is deleted afterwards. `deploy/azure/set-key.test.sh` checks this in CI.

| Key | What it turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude for the interviewer, triage, meeting analysis, persona simulation and feedback chat. Without it these use an offline stand-in. |
| `LLM_DAILY_BUDGET_USD`, `LLM_MONTHLY_BUDGET_USD` | The most Concord spends on Claude per UTC day and month, in dollars (default 5 and 40). Past either, AI features use the offline stand-in until the limit resets. Totals survive restarts and demo resets. |
| `CONCORD_PROXY_SECRET` | Must equal the Vercel variable of the same name (step 5). Lets the backend trust the domain and visitor IP the Vercel middleware forwards. |
| `PUBLIC_ORIGINS` | Comma-separated extra origins, such as a domain pointed straight at the backend, that may appear in OAuth metadata and MCP URLs when reached directly. Vercel domains don't need listing when `CONCORD_PROXY_SECRET` is set. |
| `TRUST_PROXY` | Which proxies' `X-Forwarded-*` headers to believe, in [Express's syntax](https://expressjs.com/en/guide/behind-proxies.html). The default, `loopback, linklocal, uniquelocal`, covers Caddy on the same Docker network. OAuth URLs never come from these headers. |
| `OPENAI_APPS_CHALLENGE` | The domain verification token from OpenAI's plugin submission, served at `/.well-known/openai-apps-challenge`. |
| `ADMIN_WEBIDS` | WebIDs of the deployment's administrators, who can reset the demo and read every tester's feedback. Use your own WebID and sign in with it ("Sign in with Solid"), or sign in with Google or GitHub and copy the WebID from Settings; then `./deploy/azure/set-key.sh ADMIN_WEBIDS`. Demo accounts and personas never count. Each tester's `concord/feedback/` folder in their pod is shared read-only with these WebIDs (re-applied at every start, so removing one takes its access away), testers are shown them on the feedback page, and an admin signed in with their WebID can read the folders straight from the pods under Admin → Feedback. |
| `SOLID_OIDC` | Signing in with your own WebID (Solid-OIDC with DPoP). On by default; `off` hides it. Providers fetch the Client ID Document at `<vercel-url>/auth/solid/client.jsonld`; the redirect URI is `<vercel-url>/auth/solid/callback`. |
| `SOLID_TRUSTED_ISSUERS` | Only for development and tests: Solid providers that may be on a private address or plain http (such as a local Community Solid Server). Everyone else's provider must be public https. |
| `ADMIN_EMAILS` | The older alternative: verified emails of Google or GitHub accounts. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Create an OAuth client (Web application) in Google Cloud with redirect URI `<vercel-url>/auth/google/callback`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. Create an OAuth app with callback URL `<vercel-url>/auth/github/callback`. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | Let people connect apps for app checks through the Concord GitHub App instead of a token. See [the Concord GitHub App](github-app.md) for registering it. |
| `GITHUB_PUBLISH_TOKEN`, `GITHUB_PUBLISH_OWNER` | Push each ontology's git history and release tags to a GitHub repository on release. |
| `GITHUB_PUBLISH_WRITES_PER_HOUR` | With `ONTOLOGY_STORE=db`: the most GitHub writes publishing makes in an hour, across all ontologies (default 400). See [ontology-store.md](ontology-store.md). |
| `FEEDBACK_GITHUB_TOKEN` | Lets testers opt in to posting a short summary of their feedback as a GitHub issue (see [public feedback summaries](feedback-issues.md)). A fine-grained token for this one repository with **Issues: Read and write**. Optional: `FEEDBACK_GITHUB_REPO` (default `standards-concord/standards-concord`), `FEEDBACK_ISSUES_PER_HOUR` (default 10, rolling, shared by all server processes), `FEEDBACK_TRIAGE_TOKEN` (a long random secret the triage routine sends to the server's triage endpoints; without it they're off). |
| `RECALL_API_KEY` | The live Google Meet co-facilitator bot (Recall.ai). Its webhook comes in through Vercel. |
| `MEET_BOT_EMAIL`, `MEET_BOT_ICS_URL` | Invite the bot by email: its Google account's address, and that calendar's secret iCal address. See [meet-bot.md](meet-bot.md). |
| `OPENAI_API_KEY` with `STT_PROVIDER=openai` | Voice feedback in browsers without built-in speech recognition (Firefox). |
| `CONCORD_ENCRYPTION_KEY` | 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Seals secrets Concord keeps in its database: an administrator's Solid login, so any instance can read pods as them, and the Solid logins Concord writes people's own pods with (step 5e). Needed on Vercel: without it, reading testers' pods is turned off there (the next request can reach another instance). On the VM, without it, the login stays in the server's memory (`CONCORD_ADMIN_LOGINS_IN_MEMORY`, on by default off Vercel). |
| `CONCORD_SHARED_LIMITS` | Count rate limits (OAuth, public validation, change checks) in the database, shared by every instance. On by default on Vercel. |
| `CONCORD_SCHEDULE`, `CRON_SECRET` | How scheduled work starts (see [Scheduled work](#scheduled-work)): `timer` (the default on a server) or `requests` (the default on Vercel). `CRON_SECRET` is the secret Vercel Cron sends to `GET /api/cron/daily`. Without it, that endpoint refuses every call. |
| `DEMO_MODE`, `ALLOW_PUBLIC_RESET` | Demo sign-in and the simulated working group (on by default); whether any tester can reset the shared demo (off). |
| `GHCR_USER`, `GHCR_TOKEN` | Only if the image is made private again: a token with `read:packages`. |

## Running the server

- **Shell access:** there is no SSH port. `az vm run-command invoke -g concord -n concord --command-id RunShellScript --scripts "cd /opt/concord && docker compose --env-file stack.env logs --tail 100 concord"` shows the logs; any other command works the same way.
- **Deploy now** instead of waiting five minutes: run `systemctl start concord-refresh.service` the same way.
- **Upgrades are exclusive.** Only one server process may run against the data at a time, because versions can differ in how they keep the ontologies' git repositories. `docker compose up` stops the old container before starting the new one, which is all it takes. A server holds the data with a claim in the database that lapses 30 seconds after it was last renewed. It renews the claim every 5 seconds, and checks and renews it immediately before every change to git or the files. A new server waits up to 35 seconds for another server's claim to lapse, then refuses to start. A server that finds another has taken over (for example after it stalled) changes nothing and exits. One gap is known and accepted: a server that stalls for more than 30 seconds between a check and the write right after it can still make that one write after another server has started, because no check-then-write can rule that out. With one server, a 30-second claim and checks right before each write, that would take a stall long enough that the old server's container is normally already gone. So don't run two at once, for example in a rolling or blue-green deploy. A demo reset keeps the claim.
- **Backups:** the disk is snapshotted daily at 03:00 UTC (incremental snapshots named `concord-YYYYMMDD` in the resource group), and snapshots older than 14 days are deleted. The disk holds the database, every ontology's git history and the Solid pods.
- **Your own domain:** point DNS A records for the hostname and `pods.` under it at the static IP, change `HOST` in `/opt/concord/stack.env`, restart the stack, and change `BACKEND_URL` in Vercel.
- **Moving Concord's public address** (the domain people and agents use): add the domain in Vercel, set `PUBLIC_URL` to it with `set-key.sh`, run `node scripts/public-url.mjs https://<new-origin>` and merge so the plugins and MCP Registry entry follow. Keep the old domain serving Concord for a few weeks: installed plugins only move when they update, and every agent has to sign in again at the new address, because OAuth tokens are tied to the address they were issued for.
- **Removing it:** `az group delete -n concord` deletes the VM, its IP address, disk and snapshots.

## Scheduled work

Some of Concord's work runs on a schedule: the governance clock (closing review periods and votes, auto-merging, drafting releases, publishing to GitHub), the Meet bot's calendar, GitHub App runs a request didn't start, and retries of public feedback summaries. All of it lives in [scheduler.ts](../apps/server/src/services/scheduler.ts). Each job says how often it is due, and a run does whatever is due:

- **On the server**, a timer looks every minute (`CONCORD_SCHEDULE=timer`).
- **On Vercel**, there is no long-running process (`CONCORD_SCHEDULE=requests`). Each instance looks for due work after a request, at most every 30 seconds. So deadlines are met as soon as anyone visits, including on public pages, and a failed job is retried on the next request. A Vercel Cron call to `GET /api/cron/daily` once a day (the Hobby plan's limit) runs every job, due or not, to catch up after a quiet day.

Only one run goes at a time across every instance. A run takes a lease in the database and renews it every 100 seconds while its jobs run, so the lease lapses only when its runner has died or stalled for five minutes; then another run may start. The lease is not a fence: a runner that stalls that long and then resumes finishes its jobs beside the new run, and logs that it lost the lease. That is an accepted limit because each job guards its own writes (see the next section). Work a job starts and doesn't wait for, such as a Meet bot's requests to Recall.ai, is kept running after the response that started it, with Vercel's `waitUntil`, which the Vercel entry point sets.

What waits for a visitor or the daily call on Vercel (accepted, issue #112):

- **Booking the Meet bot.** Approving a call books its bot straight away, with the time to join, so the bot joins on time even if nobody visits Concord afterwards. A series that is already approved has its calls found up to two weeks ahead, and the daily call books them in time. A brand-new invite waits for a facilitator to approve it on the Meetings page.
- **Ending a call.** A call past its slot that has gone quiet for ten minutes, or that has overrun by three hours, is ended by the next scheduled run, and a quiet call sends no requests to start one. Until a visitor or the daily call comes, the bot can stay in the call. Recall.ai takes it out by itself only when everyone has left, or after six hours in the call, which is a much weaker limit. The call's summary and any retries also wait for that run. Recall.ai's status webhook would end that wait; it is the follow-up in #112.
- **Governance deadlines** (a review period ending, a vote closing) are applied just after the next visit's response, and in the daily call.

## Running more than one instance

Vercel runs several function instances at once, each with its own memory, so nothing that must hold across requests lives in one process:

- **Changes to one meeting** (bookings, transcript lines from the bot's webhook, skips, cancellations from the calendar) run in a database transaction, which holds the store's one writer lock; the lock in each process only queues that instance's callers ([meetings.ts](../apps/server/src/services/meetings.ts), `meetingLock`).
- **A calendar invite's meeting** is looked for and created in one transaction, so there is one record (and one bot) per occurrence however many instances sync at once. Each read of the calendar feed is numbered as it starts; a read older than one already applied is dropped, and each of its writes checks under the writer lock that it is still the newest, so a slow reply can't bring back a call a newer one cancelled.
- **Requests to Recall.ai for one meeting** (its "lane") and **changes to the set of calendar calls** (a sync or an import) hold a short lease in the database ([lease.ts](../apps/server/src/lease.ts)), so another instance leaves them alone and the next sweep picks up anything it missed. The leases don't fence: every bot step is a compare-and-set and every Recall.ai request is idempotent, so a run that outlasts its lease only repeats a request.
- **Scheduled work** runs under one lease too (see Scheduled work above).

## The API as a Vercel function

Since step 5 the API can run on Vercel itself, as one function, instead of on the VM. [scripts/vercel-build.mjs](../scripts/vercel-build.mjs) is Vercel's build command. It builds the web app and the function in Vercel's Build Output API format (`.vercel/output`):

- **The function** holds the server's source, `@concord/core` and `@concord/shared` (with their fixtures), and the server's production dependencies, about 115 MB of Vercel's 250 MB. It loads the TypeScript at run time with tsx, as `node --import tsx` does on the VM, because the validation pool and the reasoner start workers from files next to their sources. Its entry is [apps/server/vercel-entry.mjs](../apps/server/vercel-entry.mjs), and [src/vercel.ts](../apps/server/src/vercel.ts) opens the database on an instance's first request. Start-up work ([src/startup.ts](../apps/server/src/startup.ts)) runs once per deployment, after that request's response, on Vercel's `waitUntil`.
- **It needs** `DATABASE_URL` (Neon) and the database-backed ontology store. Without them it answers 503 rather than keep data on the temporary disk. Private data for Google and GitHub accounts is kept in the database; people who sign in with Solid keep theirs in their own pod (below). Videos redirect to GitHub, and only small media files are cached in `/tmp` (at most 4 MB each, counted as they arrive, and 32 MB in all, the oldest removed first).
- **Routing** (`.vercel/output/config.json`) sends the paths the middleware used to forward to the VM (`/api`, `/auth`, `/mcp`, `/people`, `/def`, `/healthz`, `/.well-known/*` and the OAuth endpoints) to the function. Everything else is the web app. The daily cron calls `/api/cron/daily`.
- **Requests** are capped at 4 MB (JSON, MCP and voice clips; Vercel refuses anything over 4.5 MB), with a message that says so. That is about 15 minutes of speech.
- **Domains and visitors.** The function uses the domain each request was made to for OAuth and MCP URLs, so previews and new custom domains work without settings. It rate-limits by the visitor's address, which Vercel's edge sets. `CONCORD_PROXY_SECRET` is only needed while the middleware forwards to a server.
- **Back to the VM:** set `BACKEND_URL` (or `CONCORD_API=backend`) and redeploy. The build then makes the web app only, and the middleware forwards the API to that server as before. `CONCORD_API=function` builds the function even with `BACKEND_URL` set, for a preview while production still uses the VM. Once Vercel has taken writes, moving back also needs the data exported ([cutover.md](cutover.md)).

**Accepted limit: the 300-second deadline.** An invocation, with the work it hands to `waitUntil`, is stopped after 300 seconds (`maxDuration`). Calls to the language model and reasoning jobs have their own timeouts but no shared deadline for the invocation, so a long chain of them (a large synthesis, or several reasoning jobs queued on one instance) can be cut off part way. Most steps save in one transaction, so nothing is left half-written, and the steps that claim work recover it: an analysis whose claim lapsed starts again when someone opens the meeting, a chat message whose post was cut off (or got no answer) is marked as perhaps sent rather than sent twice, and a demo seed cut short is cleared, only the unfinished demo, and seeded again on a later start-up. A multi-step flow that is cut off between its steps (a synthesis that saved some requests and not others) keeps what it saved. What is lost is the unfinished work itself, which the person asks for again (the request gets an error, or the page shows the step as not done). Work that routinely needs longer belongs in a queue with its own worker, which the alpha doesn't need yet.

**People's own pods (step 5e).** On Vercel (`CONCORD_SOLID_OWN_PODS`, on by default there), someone who signs in with Solid has their private data (use cases, interview transcripts, their testing record and feedback) written as them in their own pod, in a `concord/` folder that Concord makes private to them before its first write (its own access control: the owner only, nothing inherited). Their pod is the one their WebID profile names (`pim:storage`), or else the nearest folder above their WebID that says it is a pod. Their Solid login is kept, sealed with `CONCORD_ENCRYPTION_KEY`, one per account and replaced at each Solid sign-in, so work after their request (a synthesis, sharing the feedback folder with the administrators) can write as them too; it is refreshed by one instance at a time. Its requests go only inside that pod. When the pod can't be written (it refuses, the login has ended, or the pod uses ACP access control, which Concord doesn't write yet), the person is told, and nothing is kept in the database instead. Without the key, Solid accounts' private writes are refused, saying so. Google and GitHub accounts keep theirs in the database. The VM keeps the pods it made on its own Solid server until the cutover.

To check a build on your own machine: `node scripts/vercel-build.mjs --function`, then `VERCEL=1 DATABASE_URL=postgres://… node scripts/vercel-serve.mjs 8799` serves the function's routes.

## Alternative: AWS

[deploy/aws/concord.yaml](../deploy/aws/concord.yaml) is a CloudFormation template for the same server on a t3.small EC2 instance (about $20 a month), with keys in Secrets Manager. Upload it in CloudFormation, set `PublicUrl` and any keys, and use its `BackendUrl` output as above.

## Why the backend is a server

The ontology is also available in the browser: the Query tab loads it into sparq and runs SPARQL and SHACL checks locally, and the health panel can rerun the OWL 2 DL reasoner (sparq's `checkOwlDl`) in the browser. The server runs the same reasoner, with no Java, because the result gates change requests and must not come from the reviewer's own machine. The rest needs a server that stays up:

- **Agents** connect to `/mcp` from their own machines, signing in with OAuth, and their gap reports open change requests that everyone sees.
- **Live meetings** need a webhook that Recall.ai calls as people speak; the meeting page asks every couple of seconds for new lines and the co-facilitator's prompts.
- **The governance clock** has to run when nobody has the site open, so review periods end and votes close on time.
- **Private data** goes into Solid pods on the bundled Community Solid Server, and each ontology's history lives in git.
