# Deploying Concord

Concord runs in two parts:

- **Vercel** serves the web app, including the in-browser query engine (sparq, WebAssembly). A small routing middleware ([middleware.ts](../middleware.ts)) forwards `/api`, `/auth`, `/mcp`, `/people` and `/healthz` to the backend, with cookies, request bodies and streamed responses passed through. People and coding agents only ever use the Vercel link.
- **One small VM** runs everything that needs a long-running server: the API, sign-in, the MCP endpoint for agents, live meeting streams and the Meet bot webhook, the governance clock (a tick every minute that closes review periods and votes, merges and drafts releases), git history for each ontology, the HermiT reasoner, and a Community Solid Server for private data. Caddy gives it HTTPS automatically. It runs on Azure, launched by one script, [deploy/azure/deploy.sh](../deploy/azure/deploy.sh). An AWS version is kept as an alternative (see the end of this page).

GitHub Actions ([ci.yml](../.github/workflows/ci.yml)) typechecks and tests every push, then builds the backend image and pushes it to GitHub's container registry. The server checks for a new image every five minutes, so merging to `main` is the deploy. Vercel redeploys the web app on every push by itself.

## Cost

The default VM size, `Standard_B2ats_v2` (2 vCPU, 1 GB of RAM plus 4 GB of swap), is one of the sizes that Azure for Students gives 750 free hours a month of for the first 12 months, along with the 64 GB SSD. What is left to pay from the student credit is the static public IP address and the daily snapshots, a few dollars a month. Vercel's free Hobby plan is enough for an alpha. Claude API usage is billed separately.

If the server is slow during reasoning checks, move it to `Standard_B2als_v2` (4 GB of RAM), which is billed against the credit: `az vm resize -g concord -n concord --size Standard_B2als_v2`. When the credit runs out, Azure disables the subscription unless it is upgraded to pay-as-you-go.

## Steps

1. **Build the backend image.** Merge to `main`. The CI workflow's `image` job publishes `ghcr.io/jeswr/standards-concord:latest`, which is public, so the server needs no token to pull it.

2. **Create the Vercel project.** In Vercel, Add New, Project, and import `jeswr/standards-concord`. Leave the root directory as the repository root; the build settings come from [vercel.json](../vercel.json). Until step 4 is done, API calls return a message saying `BACKEND_URL` is missing.

3. **Launch the backend.** On a machine with the Azure CLI, sign in with `az login`, then from the repository run:

   ```sh
   PUBLIC_URL=https://standards-concord.vercel.app ADMIN_EMAILS=you@example.org ./deploy/azure/deploy.sh
   ```

   It creates a resource group `concord` in UK South with the VM, a static IP address and a firewall that only opens ports 80 and 443, and prints the `BackendUrl` (for example `https://203.0.113.10.sslip.io`). `LOCATION`, `RESOURCE_GROUP` and `VM_SIZE` can be set the same way if a student subscription does not allow UK South. The server takes a few minutes to start and get its certificate.

4. **Connect the two.** In Vercel, Settings, Environment Variables, add `BACKEND_URL` with the `BackendUrl` value for Production and Preview, then redeploy from the Deployments tab.

5. **Add the Claude key.** `./deploy/azure/set-key.sh ANTHROPIC_API_KEY` asks for the value without showing it, so the interviewer, triage, meeting analysis, persona simulation and feedback chat use Claude.

6. **Check it.** `https://<vercel-url>/healthz` should return `{"ok":true}`. Send testers `https://<vercel-url>/alpha`.

## Adding keys later

Keys live in `/opt/concord/keys.env` on the server. `./deploy/azure/set-key.sh NAME` adds or changes one; the server applies it within five minutes.

| Key | What it turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude for the interviewer, triage, meeting analysis, persona simulation and feedback chat. Without it these use an offline stand-in. |
| `ADMIN_EMAILS` | Comma-separated emails that can reset the demo and read every tester's feedback once signed in with Google or GitHub. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Create an OAuth client (Web application) in Google Cloud with redirect URI `<vercel-url>/auth/google/callback`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. Create an OAuth app with callback URL `<vercel-url>/auth/github/callback`. |
| `GITHUB_PUBLISH_TOKEN`, `GITHUB_PUBLISH_OWNER` | Push each ontology's git history and release tags to a GitHub repository on release. |
| `RECALL_API_KEY` | The live Google Meet co-facilitator bot (Recall.ai). Its webhook comes in through Vercel. |
| `OPENAI_API_KEY` with `STT_PROVIDER=openai` | Voice feedback in browsers without built-in speech recognition (Firefox). |
| `DEMO_MODE`, `ALLOW_PUBLIC_RESET` | Demo sign-in and the simulated working group (on by default); whether any tester can reset the shared demo (off). |
| `GHCR_USER`, `GHCR_TOKEN` | Only if the image is made private again: a token with `read:packages`. |

## Running the server

- **Shell access:** there is no SSH port. `az vm run-command invoke -g concord -n concord --command-id RunShellScript --scripts "cd /opt/concord && docker compose --env-file stack.env logs --tail 100 concord"` shows the logs; any other command works the same way.
- **Deploy now** instead of waiting five minutes: run `systemctl start concord-refresh.service` the same way.
- **Backups:** the disk is snapshotted daily at 03:00 UTC (incremental snapshots named `concord-YYYYMMDD` in the resource group), and snapshots older than 14 days are deleted. The disk holds the database, every ontology's git history and the Solid pods.
- **Your own domain:** point DNS A records for the hostname and `pods.` under it at the static IP, change `HOST` in `/opt/concord/stack.env`, restart the stack, and change `BACKEND_URL` in Vercel.
- **Removing it:** `az group delete -n concord` deletes the VM, its IP address, disk and snapshots.

## Alternative: AWS

[deploy/aws/concord.yaml](../deploy/aws/concord.yaml) is a CloudFormation template for the same server on a t3.small EC2 instance (about $20 a month), with keys in Secrets Manager. Upload it in CloudFormation, set `PublicUrl` and any keys, and use its `BackendUrl` output as above.

## Why the backend is a server

The ontology is also available in the browser: the Query tab loads it into sparq and runs SPARQL and SHACL checks locally. The rest needs a server that stays up:

- **Agents** connect to `/mcp` from their own machines with a token, and their gap reports open change requests that everyone sees.
- **Live meetings** need a webhook that Recall.ai calls as people speak, and a stream that pushes the co-facilitator's prompts to everyone watching.
- **The governance clock** has to run when nobody has the site open, so review periods end and votes close on time.
- **Full OWL DL reasoning** uses HermiT. sparq's WebAssembly build covers RDFS and OWL 2 RL, and its DL reasoner covers ALCH, which is not enough for the qualified cardinality restrictions and functional properties the standards use. When sparq's DL reasoner covers OWL 2 DL, consistency checks can move into the browser as well.
- **Private data** goes into Solid pods on the bundled Community Solid Server, and each ontology's history lives in git.
