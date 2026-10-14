# Deploying Concord

Concord runs in two parts:

- **Vercel** serves the web app, including the in-browser query engine (sparq, WebAssembly). A small routing middleware ([middleware.ts](../middleware.ts)) forwards `/api`, `/auth`, `/mcp`, `/people` and `/healthz` to the backend, with cookies, request bodies and streamed responses passed through. People and coding agents only ever use the Vercel link.
- **One EC2 instance** runs everything that needs a long-running server: the API, sign-in, the MCP endpoint for agents, live meeting streams and the Meet bot webhook, the governance clock (a tick every minute that closes review periods and votes, merges and drafts releases), git history for each ontology, the HermiT reasoner, and a Community Solid Server for private data. Caddy gives it HTTPS automatically. It is launched from one CloudFormation template, [deploy/aws/concord.yaml](../deploy/aws/concord.yaml).

GitHub Actions ([ci.yml](../.github/workflows/ci.yml)) typechecks and tests every push, then builds the backend image and pushes it to GitHub's container registry. The server checks for a new image every five minutes, so merging to `main` is the deploy. Vercel redeploys the web app on every push by itself.

## Cost

About $20 a month in total: a t3.small instance (about $15), its public IP address (about $3.60), a 20 GB disk and its daily snapshots (about $2), and the secret holding the API keys ($0.40). Vercel's free Hobby plan is enough for an alpha. Claude API usage is billed separately.

## Steps

1. **Build the backend image.** Merge the pull request into `main`. The CI workflow's `image` job publishes `ghcr.io/jeswr/standards-concord:latest`. (To deploy a branch without merging, use its tag instead, for example `ghcr.io/jeswr/standards-concord:claude-concord-prototype`.)

2. **Let the server pull the image.** While the repository is private, so is the image. Either make the package public (GitHub, your profile, Packages, standards-concord, Package settings, Change visibility), or create a classic personal access token with only the `read:packages` scope to paste into the template.

3. **Create the Vercel project.** In Vercel, Add New, Project, and import `jeswr/standards-concord`. Leave the root directory as the repository root; the build settings come from [vercel.json](../vercel.json). Deploy, and note the URL, for example `https://standards-concord.vercel.app`. Until the next step is done, API calls return a message saying `BACKEND_URL` is missing.

4. **Launch the backend.** In the AWS console, choose a region (London is `eu-west-2`), open CloudFormation, Create stack, With new resources, and upload `deploy/aws/concord.yaml`. Fill in:
   - `PublicUrl`: the Vercel URL from step 3, with no trailing slash.
   - `GhcrToken`: the token from step 2, unless you made the image public.
   - `AnthropicApiKey`: so the interviewer, triage, meeting analysis, persona simulation and feedback chat use Claude.
   - `AdminEmails`: your email, so you can reset the demo and read every tester's feedback once you sign in with Google or GitHub.
   - Everything else is optional and can be added later (see below).

   Tick the box acknowledging IAM resources and create the stack. It takes about five minutes, plus a minute or two for the server to start and get its certificate.

5. **Connect the two.** Copy the stack's `BackendUrl` output (for example `https://203.0.113.10.sslip.io`). In Vercel, Settings, Environment Variables, add `BACKEND_URL` with that value for Production and Preview, then redeploy from the Deployments tab.

6. **Check it.** `https://<vercel-url>/healthz` should return `{"ok":true}`. Send testers `https://<vercel-url>/alpha`.

## Adding keys later

All API keys live in one Secrets Manager secret (the stack's `SecretToEdit` output). Edit its JSON in the AWS console to add or rotate a key; the server reads it again within five minutes and restarts Concord if anything changed. No stack update is needed.

| Key | What it turns on |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Create an OAuth client (Web application) in Google Cloud with redirect URI `<vercel-url>/auth/google/callback`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. Create an OAuth app with callback URL `<vercel-url>/auth/github/callback`. |
| `GITHUB_PUBLISH_TOKEN`, `GITHUB_PUBLISH_OWNER` | Push each ontology's git history and release tags to a GitHub repository on release. |
| `RECALL_API_KEY` | The live Google Meet co-facilitator bot (Recall.ai). Its webhook comes in through Vercel. |
| `OPENAI_API_KEY` with `STT_PROVIDER=openai` | Voice feedback in browsers without built-in speech recognition (Firefox). |
| `DEMO_MODE`, `ALLOW_PUBLIC_RESET` | Demo sign-in and the simulated working group (on by default); whether any tester can reset the shared demo (off). |

## Running the server

- **Shell access:** the `ShellAccess` output is a Session Manager command; there is no SSH port. Files are in `/opt/concord`; `docker compose --env-file stack.env logs -f concord` shows the logs.
- **Deploy now** instead of waiting five minutes: `sudo /opt/concord/refresh.sh`.
- **Backups:** the disk is snapshotted daily at 03:00 UTC and snapshots are kept for 14 days (EC2, Snapshots). The disk holds the database, every ontology's git history and the Solid pods.
- **Your own domain:** point a DNS A record at the Elastic IP, update the stack with `DomainName` set to that hostname (this replaces the instance, so restore from a snapshot if you need the data), and change `BACKEND_URL` in Vercel.
- **Removing it:** delete the stack. Snapshots taken by the backup policy are kept until you delete them.

## Why the backend is a server

The ontology is also available in the browser: the Query tab loads it into sparq and runs SPARQL and SHACL checks locally. The rest needs a server that stays up:

- **Agents** connect to `/mcp` from their own machines with a token, and their gap reports open change requests that everyone sees.
- **Live meetings** need a webhook that Recall.ai calls as people speak, and a stream that pushes the co-facilitator's prompts to everyone watching.
- **The governance clock** has to run when nobody has the site open, so review periods end and votes close on time.
- **Full OWL DL reasoning** uses HermiT. sparq's WebAssembly build covers RDFS and OWL 2 RL, and its DL reasoner covers ALCH, which is not enough for the qualified cardinality restrictions and functional properties the standards use. When sparq's DL reasoner covers OWL 2 DL, consistency checks can move into the browser as well.
- **Private data** goes into Solid pods on the bundled Community Solid Server, and each ontology's history lives in git.
