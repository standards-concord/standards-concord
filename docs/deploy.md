# Deploying Concord

Concord runs entirely on Vercel, with its data in a Neon Postgres database:

- **The web app**, including the in-browser query engine (sparq, WebAssembly), is served as static files.
- **The API** (sign-in, the MCP endpoint for agents, live meeting streams and the Meet bot webhook, the governance clock, and each ontology's history) runs as one Vercel function, built by [scripts/vercel-build.mjs](../scripts/vercel-build.mjs) (see [The API as a Vercel function](#the-api-as-a-vercel-function)). It keeps everything in Neon (`DATABASE_URL`), including private data for people who sign in with Google, GitHub or the demo. People who sign in with Solid keep theirs in their own pod.

People and coding agents only ever use the Vercel link. Until 21 November 2026 the API ran on a small Azure VM, which the routing middleware ([middleware.ts](../middleware.ts)) forwarded to; [cutover.md](cutover.md) records how its data moved into Neon. The middleware can still forward the API to a server of your own (`BACKEND_URL`, see [Running your own server](#running-your-own-server)).

GitHub Actions ([ci.yml](../.github/workflows/ci.yml)) typechecks and tests every pull request and every push to `main`. [vercel-deploy.yml](../.github/workflows/vercel-deploy.yml) builds and deploys `main` to Vercel whenever a push changes the web app, the server or the build, so merging to `main` is the deploy. Other branches and pull requests get no Vercel build (the free plan allows 100 deployments a day, and CI already tests the production build); `git.deploymentEnabled` and `ignoreCommand` in [vercel.json](../vercel.json) set this. [ci.md](ci.md) explains what runs when, and how to keep within the free minutes; [moving-accounts.md](moving-accounts.md) covers moving to a dedicated GitHub organisation and Vercel account.

## Cost

Vercel's free Hobby plan and Neon's free plan are enough for an alpha. Claude API usage is billed separately, within the budgets below.

## Steps

1. **Create the Vercel project.** In Vercel, Add New, Project, and import `standards-concord/standards-concord`. Leave the root directory as the repository root; the build settings come from [vercel.json](../vercel.json).

2. **Add the database.** From the project's Storage tab, connect a Neon database (the free plan is enough). This sets `DATABASE_URL` and its companions for every environment. A new, empty database needs nothing else: the function creates its tables on its first request and seeds the demo when `DEMO_MODE` is on.

3. **Add the keys** below as environment variables (Production, Sensitive). At least `CONCORD_ENCRYPTION_KEY` and `CRON_SECRET` (each `openssl rand -hex 32`), and `ANTHROPIC_API_KEY` so the interviewer, triage, meeting analysis, persona simulation and feedback chat use Claude.

4. **Deploy.** Add the repository secret `VERCEL_TOKEN` (a token from the Vercel account, scoped to its team) so [vercel-deploy.yml](../.github/workflows/vercel-deploy.yml) deploys each merge, or run it by hand from the Actions tab. A redeploy from Vercel's dashboard reuses the last build's output, so after changing a variable the build reads (`BACKEND_URL`, `CONCORD_API`), run the workflow instead.

5. **Check it.** `./deploy/smoke.sh https://<vercel-url>` signs in as a demo tester and exercises the API, validation with the OWL reasoner, SPARQL, an interview, a change request and the MCP endpoint, and checks that the welcome page's videos are there and play (`scripts/check-media.mjs`; see [walkthrough/README.md](../walkthrough/README.md#releases)). Then send testers `https://<vercel-url>/alpha`.

## Adding keys later

Keys are Vercel environment variables. Add or change one in the project's Settings, Environment Variables (Production, Sensitive), or from a terminal with `vercel env add NAME production`, which asks for the value without showing it. Then redeploy (step 4) so the function sees it.

| Key | What it turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude for the interviewer, triage, meeting analysis, persona simulation and feedback chat. Without it these use an offline stand-in. |
| `LLM_DAILY_BUDGET_USD`, `LLM_MONTHLY_BUDGET_USD` | The most Concord spends on Claude per UTC day and month, in dollars (default 5 and 40). Past either, AI features use the offline stand-in until the limit resets. Totals survive restarts and demo resets. |
| `PUBLIC_ORIGINS` | Comma-separated extra origins that may appear in OAuth metadata and MCP URLs. The function uses the domain each request was made to, so Vercel domains don't need listing. |
| `OPENAI_APPS_CHALLENGE` | The domain verification token from OpenAI's plugin submission, served at `/.well-known/openai-apps-challenge`. |
| `ADMIN_WEBIDS` | WebIDs of the deployment's administrators, who can reset the demo and read every tester's feedback. Use your own WebID and sign in with it ("Sign in with Solid"), or sign in with Google or GitHub and copy the WebID from Settings. Demo accounts and personas never count. Each tester's `concord/feedback/` folder in their pod is shared read-only with these WebIDs (re-applied at every start, so removing one takes its access away), testers are shown them on the feedback page, and an admin signed in with their WebID can read the folders straight from the pods under Admin → Feedback. |
| `SOLID_OIDC` | Signing in with your own WebID (Solid-OIDC with DPoP). On by default; `off` hides it. Providers fetch the Client ID Document at `<vercel-url>/auth/solid/client.jsonld`; the redirect URI is `<vercel-url>/auth/solid/callback`. |
| `SOLID_TRUSTED_ISSUERS` | Only for development and tests: Solid providers that may be on a private address or plain http (such as a local Community Solid Server). Everyone else's provider must be public https. |
| `ADMIN_EMAILS` | The older alternative: verified emails of Google or GitHub accounts. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Create an OAuth client (Web application) in Google Cloud with redirect URI `<vercel-url>/auth/google/callback`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. Create an OAuth app with callback URL `<vercel-url>/auth/github/callback`. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | Let people connect apps for app checks through the Concord GitHub App instead of a token. See [the Concord GitHub App](github-app.md) for registering it. |
| `GITHUB_PUBLISH_TOKEN`, `GITHUB_PUBLISH_OWNER` | Push each ontology's git history and release tags to a GitHub repository on release. |
| `GITHUB_PUBLISH_WRITES_PER_HOUR` | With `ONTOLOGY_STORE=db`: the most GitHub writes publishing makes in an hour, across all ontologies (default 400). See [ontology-store.md](ontology-store.md). |
| `FEEDBACK_GITHUB_TOKEN` | Lets testers opt in to posting a short summary of their feedback as a GitHub issue (see [public feedback summaries](feedback-issues.md)). A fine-grained token for this one repository with **Issues: Read and write**. Optional: `FEEDBACK_GITHUB_REPO` (default `standards-concord/standards-concord`), `FEEDBACK_ISSUES_PER_HOUR` (default 10, rolling, shared by all instances), `FEEDBACK_TRIAGE_TOKEN` (a long random secret the triage routine sends to the server's triage endpoints; without it they're off). |
| `RECALL_API_KEY` | The live Google Meet co-facilitator bot (Recall.ai). Its webhook comes in through Vercel. |
| `MEET_BOT_EMAIL`, `MEET_BOT_ICS_URL` | Invite the bot by email: its Google account's address, and that calendar's secret iCal address. See [meet-bot.md](meet-bot.md). |
| `OPENAI_API_KEY` with `STT_PROVIDER=openai` | Voice feedback in browsers without built-in speech recognition (Firefox). |
| `CONCORD_ENCRYPTION_KEY` | 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Seals secrets Concord keeps in its database: an administrator's Solid login, so any instance can read pods as them, and the Solid logins Concord writes people's own pods with (step 5e). Changing the key makes every kept login unreadable: administrators and people who sign in with Solid are then asked to sign in again (sealed values carry no key id yet). Needed on Vercel: without it, reading testers' pods is turned off there (the next request can reach another instance). On a server of your own, without it, the login stays in the server's memory (`CONCORD_ADMIN_LOGINS_IN_MEMORY`, on by default off Vercel). |
| `CONCORD_SHARED_LIMITS` | Count rate limits (OAuth, public validation, change checks) in the database, shared by every instance. On by default on Vercel. |
| `CONCORD_SCHEDULE`, `CRON_SECRET` | How scheduled work starts (see [Scheduled work](#scheduled-work)): `timer` (the default on a server) or `requests` (the default on Vercel). `CRON_SECRET` is the secret Vercel Cron sends to `GET /api/cron/daily`. Without it, that endpoint refuses every call. |
| `DEMO_MODE`, `ALLOW_PUBLIC_RESET` | Demo sign-in and the simulated working group (on by default); whether any tester can reset the shared demo (off). |
| `CONCORD_READ_ONLY` | `true` answers reads and refuses every change with 503, for moving data (see [cutover.md](cutover.md)). |

## Running it

- **Logs:** the project's Logs tab in Vercel, or `vercel logs <deployment-url>`.
- **Backups:** Neon keeps a short point-in-time history on the free plan. For a copy you keep, `node --import tsx src/migrate/cli.ts export --to <empty dir>` from `apps/server`, with `DATABASE_URL` set, writes the database out as SQLite, a git repository per ontology and the private files ([cutover.md](cutover.md)).
- **Moving Concord's public address** (the domain people and agents use): add the domain in Vercel, run `node scripts/public-url.mjs https://<new-origin>` and merge so the plugins and MCP Registry entry follow. Keep the old domain serving Concord for a few weeks: installed plugins only move when they update, and every agent has to sign in again at the new address, because OAuth tokens are tied to the address they were issued for.

## Running your own server

The same API also runs as a long-running Node server with SQLite and git repositories on disk, which is what local development uses (`docker compose up`, see [development.md](development.md)). CI's `image` job publishes it as `ghcr.io/standards-concord/standards-concord:latest`. To serve Concord's API from such a server instead of the function, set `BACKEND_URL` in Vercel to its address and `CONCORD_PROXY_SECRET` to the same random value on both sides, then rerun the deploy workflow: the build then makes the web app only, and the middleware forwards `/api`, `/auth`, `/mcp`, `/people`, `/healthz` and the OAuth endpoints to it, passing on the domain the request came through and the visitor's address, vouched for by that secret. Only one server process may run against a data directory at a time (it holds a claim in its database that lapses 30 seconds after it was last renewed), so don't use rolling or blue-green deploys.

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

Since step 5 the API runs on Vercel itself, as one function, instead of on a server. [scripts/vercel-build.mjs](../scripts/vercel-build.mjs) is Vercel's build command. It builds the web app and the function in Vercel's Build Output API format (`.vercel/output`):

- **The function** holds the server's source, `@concord/core` and `@concord/shared` (with their fixtures), and the server's production dependencies, about 115 MB of Vercel's 250 MB. It loads the TypeScript at run time with tsx, as `node --import tsx` does on a server, because the validation pool and the reasoner start workers from files next to their sources. Its entry is [apps/server/vercel-entry.mjs](../apps/server/vercel-entry.mjs), and [src/vercel.ts](../apps/server/src/vercel.ts) opens the database on an instance's first request. Start-up work ([src/startup.ts](../apps/server/src/startup.ts)) runs once per deployment, after that request's response, on Vercel's `waitUntil`.
- **It needs** `DATABASE_URL` (Neon) and the database-backed ontology store. Without them it answers 503 rather than keep data on the temporary disk. Private data for Google and GitHub accounts is kept in the database; people who sign in with Solid keep theirs in their own pod (below). Videos redirect to GitHub, and only small media files are cached in `/tmp` (at most 4 MB each, counted as they arrive, and 32 MB in all, the oldest removed first).
- **Routing** (`.vercel/output/config.json`, from `scripts/vercel-output.mjs`) sends the paths the middleware forwards to a server when `BACKEND_URL` is set (`/api`, `/auth`, `/mcp`, `/people`, `/def`, `/healthz`, `/.well-known/*` and the OAuth endpoints) to the function. Everything else is the web app. The middleware still runs first, and lets these paths through to the function, because it decides who serves the API as the build does (see below). The daily cron that calls `/api/cron/daily` is declared in `vercel.json` only: Vercel merges `vercel.json` into a prebuilt output and refuses a cron declared in both.
- **Requests** are capped at 4 MB (JSON, MCP and voice clips; Vercel refuses anything over 4.5 MB), with a message that says so. That is about 15 minutes of speech.
- **Domains and visitors.** The function uses the domain each request was made to for OAuth and MCP URLs, so previews and new custom domains work without settings. It rate-limits by the visitor's address, which Vercel's edge sets. `CONCORD_PROXY_SECRET` is only needed while the middleware forwards to a server.
- **To a server instead:** set `BACKEND_URL` (or `CONCORD_API=backend`) and rerun the deploy workflow. The build then makes the web app only, and the middleware forwards the API to that server ([Running your own server](#running-your-own-server)). `CONCORD_API=function` builds the function even with `BACKEND_URL` set, for a preview of the function while production uses a server. The middleware reads it too, so set it for the build and at run time (`vercel deploy -b CONCORD_API=function -e CONCORD_API=function`, or a project variable). Set at build time only, the middleware would forward the preview's API to the server. Once Vercel has taken writes, moving back also needs the data exported ([cutover.md](cutover.md)).

**Accepted limit: the 300-second deadline.** An invocation, with the work it hands to `waitUntil`, is stopped after 300 seconds (`maxDuration`). Calls to the language model and reasoning jobs have their own timeouts but no shared deadline for the invocation, so a long chain of them (a large synthesis, or several reasoning jobs queued on one instance) can be cut off part way. Most steps save in one transaction, so nothing is left half-written, and the steps that claim work recover it: an analysis whose claim lapsed starts again when someone opens the meeting, a chat message whose post was cut off (or got no answer) is marked as perhaps sent rather than sent twice, and a demo seed cut short is cleared, only the unfinished demo, and seeded again on a later start-up. A multi-step flow that is cut off between its steps (a synthesis that saved some requests and not others) keeps what it saved. What is lost is the unfinished work itself, which the person asks for again (the request gets an error, or the page shows the step as not done). Work that routinely needs longer belongs in a queue with its own worker, which the alpha doesn't need yet.

**People's own pods (step 5e).** On Vercel (`CONCORD_SOLID_OWN_PODS`, on by default there), someone who signs in with Solid has their private data (use cases, interview transcripts, their testing record and feedback) written as them in their own pod, in a `concord/` folder. Their pod is the one their WebID profile names (`pim:storage`), or else the nearest folder above their WebID that says it is a pod.

- **Private first.** Before each write Concord checks that the folder is private to them: an access control of its own giving the owner access to it and everything in it (`acl:default`), and nobody else anything. It makes one if there is none. An existing one (the person's, or one made meanwhile) is read and checked, never trusted. So is any access control on the folders and the document below it, including ones made in advance for paths not there yet. Besides the owner, the only rule allowed is Concord's own read-only share of the feedback folder, and it may name only the administrators (`ADMIN_WEBIDS`). Anything else is refused with nothing written, and the person is told what to fix.
- **Only that folder.** Paths are plain relative paths: no `..`, encoded separators, query or fragment. Requests as the person go only inside `concord/` in that pod.
- **Their login.** It is kept sealed with `CONCORD_ENCRYPTION_KEY`, bound to their account, WebID, pod and sign-in, so a sealed login copied to another record doesn't open. There is one per account, and each Solid sign-in replaces it, so work after their request (a synthesis, sharing the feedback folder with the administrators) can write as them too. One instance at a time refreshes it, and a refresh only saves into the sign-in it refreshed. Signing out forgets it, and every request as them checks that it is still kept just before it is sent, so work already under way sends nothing more. Until they sign in with Solid again, their private writes and reads are refused, asking them to.
- **Loud failures.** When the pod can't be written or read (it refuses, the login has ended, or the pod uses ACP access control, which Concord doesn't write yet), the person is told. Nothing is kept in, or read from, the database instead. Without the key, Solid accounts' private writes are refused, saying so.
- **Everyone else.** Google and GitHub accounts keep theirs in the database. (The Azure VM used to make them pods on its own Solid server; their contents moved into the database at the cutover.)

To check a build on your own machine: `node scripts/vercel-build.mjs --function`, then `VERCEL=1 DATABASE_URL=postgres://… node scripts/vercel-serve.mjs 8799` serves the function's routes.

## Alternative: AWS

[deploy/aws/concord.yaml](../deploy/aws/concord.yaml) is a CloudFormation template for the same server on a t3.small EC2 instance (about $20 a month), with keys in Secrets Manager. Upload it in CloudFormation, set `PublicUrl` and any keys, and use its `BackendUrl` output as `BACKEND_URL` ([Running your own server](#running-your-own-server)).

## Why the backend is a server

The ontology is also available in the browser: the Query tab loads it into sparq and runs SPARQL and SHACL checks locally, and the health panel can rerun the OWL 2 DL reasoner (sparq's `checkOwlDl`) in the browser. The server runs the same reasoner, with no Java, because the result gates change requests and must not come from the reviewer's own machine. The rest needs a server that stays up:

- **Agents** connect to `/mcp` from their own machines, signing in with OAuth, and their gap reports open change requests that everyone sees.
- **Live meetings** need a webhook that Recall.ai calls as people speak; the meeting page asks every couple of seconds for new lines and the co-facilitator's prompts.
- **The governance clock** has to run when nobody has the site open, so review periods end and votes close on time.
- **Private data** goes into people's own Solid pods or the database, and each ontology's history is kept as git objects.
