# The Concord GitHub App

People who connect an app on **Changes → App checks** can connect it through the Concord GitHub App instead of copying a token into a repository secret. Concord then opens the pull request that adds the workflow, starts the workflow whenever there is something new to test, and the run signs in with GitHub's own proof that it runs in that repository. The token route keeps working alongside, for CI that isn't GitHub Actions.

Code: `apps/server/src/services/githubApp.ts` (talking to GitHub), `apps/server/src/services/appGithub.ts` (linking, starting runs, the workflow pull request, webhooks), `apps/server/src/routes/githubApp.ts`. Tests: `apps/server/test/githubApp.test.ts` and `e2e/app-checks-github.spec.ts`, both against the stand-in GitHub in `e2e/github-stub.mjs`.

## Registering the App

Owned by the standards-concord organisation: <https://github.com/organizations/standards-concord/settings/apps/new>.

| Setting | Value |
| --- | --- |
| Name | Concord app checks |
| Homepage URL | `https://standards-concord.vercel.app` |
| Callback URL | `https://standards-concord.vercel.app/api/github-app/setup` |
| Expire user authorization tokens | On |
| Request user authorization (OAuth) during installation | **On** (Concord uses the one-time code to check who installed; without it, linking fails) |
| Setup URL | Blank (with OAuth on, GitHub sends installers to the callback) |
| Redirect on update | On |
| Webhook | Active, URL `https://standards-concord.vercel.app/api/github-app/webhook`, secret = `GITHUB_APP_WEBHOOK_SECRET` |
| Repository permissions | Actions: read and write. Checks: read and write. Contents: read and write. Pull requests: read and write. Workflows: read and write. Metadata: read (mandatory). |
| Organisation and account permissions | None |
| Subscribe to events | Installation target, Pull request (installation and repository events are always sent) |
| Where can it be installed | Any account |

Each installation token Concord asks for is narrowed to the one repository and the permissions the step needs: Actions to start a run; Contents, Pull requests and Workflows to open the workflow pull request. Checks is for posting results on the app's commits, which comes later.

## Server settings

All six, or the App is off and the App checks page shows only the token route.

| Variable | What |
| --- | --- |
| `GITHUB_APP_ID` | The App's number (on its settings page). Not secret. |
| `GITHUB_APP_SLUG` | Its URL name: `github.com/apps/<slug>`. Not secret. |
| `GITHUB_APP_PRIVATE_KEY` | The `.pem` from "Generate a private key". Raw, with escaped `\n` newlines, or base64 of the file. |
| `GITHUB_APP_WEBHOOK_SECRET` | A long random string, also typed into the App's webhook settings. Generate it ourselves (`openssl rand -hex 32`). |
| `GITHUB_APP_CLIENT_ID` | On the App's settings page. Not secret. |
| `GITHUB_APP_CLIENT_SECRET` | From "Generate a new client secret". |

`GITHUB_APP_API_URL` and `GITHUB_APP_WEB_URL` point it at another GitHub (the tests' stand-in). Secrets go in Vercel's environment (Production, Sensitive) and, while it runs, the VM's `/opt/concord/keys.env`. Never in the repository, a repository secret or a chat. If the private key leaks, generate a new one on the App's page and delete the old one: installation tokens last an hour.

## How it works

1. **Connecting.** The app's owner clicks **Connect with GitHub**. Concord signs a state (app, ontology, person, 15 minutes) and sends them to the App's install page. GitHub sends them back to the callback with the state, the installation id and a one-time code. Concord checks the state is its own and the person is the one who started; trades the code for the person's token; asks GitHub which repositories in that installation the person can see (so a typed-in installation id can't link someone else's repository); revokes the token; and links the app to its repository (the one set on the app, or the only one installed on), pinning the repository's numeric id.
2. **The workflow.** `workflowYaml(url, { app })` in `@concord/shared`: no secret, `app: <id>`, `id-token: write`, a daily schedule as a backstop. **Open a pull request** puts it on the `concord/app-checks` branch and opens (or updates) the pull request.
3. **Starting runs.** When a change is submitted or its edits change, or a merge moves the working draft, Concord compares a fingerprint of what there is to test (the draft and every open change's revision) with what it last started a run for, and starts `concord.yml` on the default branch with `workflow_dispatch`. At most one run per app every two minutes; the decision is recorded before GitHub is asked, so two processes can't both start one. A refusal (no workflow yet, App removed) is shown on the page and retried after 15 minutes. A sweep every minute (on Vercel: the cron) catches anything a request didn't. **Start a run now** skips the wait. When the workflow pull request is merged, GitHub's `pull_request` webhook makes Concord start a run straight away.
4. **Signing in.** With no token, the action asks GitHub for an OIDC token with audience `concord-app-check:<app id>` and sends it to `POST /api/app-checks/session`. If it comes from the pinned repository (by id), Concord uses it up and returns a run token (`cnr_…`, six hours) that works like the app token for the rest of the run. The working-draft result still carries a fresh OIDC token, so these runs are verified for autopilot exactly as token runs are.
5. **Unlinking.** Uninstalling the App, removing the repository from it, or **Stop using GitHub** on the page unlinks the app and drops its run tokens. Suspending the App pauses runs until it is unsuspended. Results already reported stay.
