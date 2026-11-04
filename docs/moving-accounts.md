# Moving Concord to its own GitHub organisation and Vercel account

Concord shares GitHub Actions minutes and Vercel's daily deployment cap with every other repository on the owner's personal accounts. Giving it its own free GitHub organisation and Vercel Hobby account separates those budgets. Nothing here needs a secret value pasted anywhere except into GitHub's or Vercel's own settings pages.

## 1. Create the GitHub organisation

1. Go to <https://github.com/account/organizations/new?plan=free>.
2. Pick a name. Lower case is simplest, because container image names are always lower case. Enter your email, choose **My personal account**, and finish. Skip inviting anyone.
3. In the new organisation: **Settings → Packages**, under **Package creation**, tick **Public**, so the backend image can stay public (the server pulls it without a token).
4. Optional but useful: **Settings → Billing and licensing → Budgets and alerts**, add a budget for **Actions** (even $10 to $20 a month) so CI doesn't stop dead at 2,000 minutes.

## 2. Transfer the repository

1. Note the repository's Actions secret **names**: **Settings → Secrets and variables → Actions**. Today they are `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` and `GOOGLE_TTS_API_KEY` (all optional, used only to voice the walkthrough video).
2. **Settings → General → Danger Zone → Transfer ownership**, choose the organisation, type the repository name, confirm.
3. GitHub redirects the old URLs (web, `git`, API) to the new home, so nothing breaks at once.
4. Check the secrets came across (**Settings → Secrets and variables → Actions** on the transferred repo). If any are missing, add them again by the same names.

## 3. Give Claude access

1. Install the Claude GitHub app on the organisation: <https://github.com/apps/claude/installations/select_target>, choose the organisation, and give it **standards-concord** (or all repositories).
2. In the Claude project, open **Project settings → Repositories** and replace `jeswr/standards-concord` with the new address.
3. Merge the PR that repoints the repository's own links. It is one command, `node scripts/move-repo.mjs <org>`, which updates the plugin and marketplace listings, the install commands on the Connect page, the container image the deploy scripts pull, and the MCP Registry name (`io.github.<org>/concord`). CI checks every link agrees (`node scripts/move-repo.mjs --check`).

## 4. Point the backend at the new image

The next `main` build publishes `ghcr.io/<org>/standards-concord`. The old `ghcr.io/jeswr/standards-concord` stops updating, so:

1. After that build, open the organisation's **Packages → standards-concord → Package settings → Change visibility → Public**.
2. On the VM, change `IMAGE=` in `/opt/concord/stack.env` to the new image, then `systemctl start concord-refresh.service`. With the Azure CLI: `az vm run-command invoke -g concord -n concord --command-id RunShellScript --scripts "sed -i 's#^IMAGE=.*#IMAGE=ghcr.io/<org>/standards-concord:latest#' /opt/concord/stack.env && systemctl start concord-refresh.service"`.

## 5. Move the site to the new Vercel account

The site should keep its address, `standards-concord.vercel.app`, because it is in the MCP listings, the OAuth set-up and testers' bookmarks. The steps below keep it.

1. Sign up at <https://vercel.com/signup> with the other email address, on the **Hobby** plan. If Vercel says your GitHub login is already linked to another Vercel account, sign up with email instead and connect GitHub in step 2.
2. **Add New → Project → Import Git Repository**, and when asked, install the Vercel GitHub app on the new organisation (only `standards-concord` is enough). Import the repository. Leave the root directory as the repository root; the framework, build command and output come from [vercel.json](../vercel.json). Name the project anything for now, such as `concord-new`.
3. Before the first deploy, or straight after it, add the environment variables under **Settings → Environment Variables** (Production), copying the values from the old project's same page:
   - `BACKEND_URL`, the backend server's address.
   - `CONCORD_PROXY_SECRET`, which must equal the backend's key of the same name. If the old value can't be revealed, generate a new one (`openssl rand -hex 32`), set it here, redeploy, then run `./deploy/azure/set-key.sh CONCORD_PROXY_SECRET` with the same value.
4. **Settings → Git**: check **Production Branch** is `main`. Nothing else is needed for previews: vercel.json already turns off every branch except `main` and skips builds that don't touch the site.
5. Redeploy and check the new `*.vercel.app` address loads and signs in.
6. In the **old** account, delete the old project (**Settings → General → Delete Project**). This frees its address.
7. In the new project, **Settings → Domains → Add**, enter `standards-concord.vercel.app`. The site is back at its usual address. Expect a few minutes of downtime between steps 6 and 7.

If the old project's **Settings → General → Transfer Project** offers the new account as a destination, transferring is quicker and keeps the address, variables and history in one go; it then replaces steps 2 to 7.

## 6. Loose ends outside the repository

- The Vercel connector Claude uses is signed in to the old Vercel account. Reconnect it to the new one under claude.ai **Settings → Connectors** if threads should keep checking deployments.
- Clones on other machines keep working through GitHub's redirect; `git remote set-url origin https://github.com/<org>/standards-concord.git` makes it explicit.
- Scheduled tasks or routines that name `jeswr/standards-concord` (such as the feedback triage routine) should be updated to the new address.
- When Google and GitHub sign-in are set up, create the GitHub OAuth app under the organisation rather than a personal account.
- After the new MCP Registry entry is live, retire `io.github.jeswr/concord` as described in [mcp-listings.md](mcp-listings.md).

## How many minutes this buys

A free organisation gets 2,000 Actions minutes a month for private repositories. With the trimmed workflows ([ci.md](ci.md)), a typical PR (a few draft pushes, one ready-for-review run and the merge to `main`) costs roughly 50 to 70 minutes, so 2,000 minutes covers about 30 to 40 merged PRs a month. That is less than a busy day of Claude threads. To keep working at that pace, one of these is needed as well:

- **Make the repository public** once its history is clean. Standard GitHub runners are free and unlimited for public repositories, and Concord is meant to be open source.
- **A spending budget** on the organisation (step 1.4). Linux minutes cost well under a cent each.
- **A self-hosted runner**, see [ci.md](ci.md#option-a-self-hosted-runner).
