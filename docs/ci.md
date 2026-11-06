# CI and deploy budgets

GitHub Actions minutes are free and unlimited on a public repository, but metered on a private one (2,000 a month on a free account or organisation, shared by all its private repos). Vercel's free Hobby plan allows 100 deployments a day. The workflows and [vercel.json](../vercel.json) are set up to stay inside both.

## What runs when

| Event | What runs | Roughly |
| --- | --- | --- |
| Push to a branch with no PR | nothing | 0 min |
| Push to a draft PR | `test` (typecheck, unit tests, build, listing checks) | 14 min |
| PR marked ready for review, and every push after | `test`, `e2e` (preview: everything; dev: smoke test), `walkthrough` | 25 min |
| Push to `main` | all of the above, then `image` (backend deploy) | 30 min |
| Vercel production deploy | `Live site` smoke test | 2 min |
| Only `docs/`, `deploy/` or Markdown changed (outside `walkthrough/`) | nothing | 0 min |
| `deploy/azure/set-key*` changed | `Deploy scripts` (checks the key never reaches a command line) | under 1 min |

Before this, every push to a PR branch ran the whole suite twice (once for the push, once for the PR) and built a branch image, about 50 billed minutes a push.

Other savings:

- **Concurrency.** A newer push to a PR cancels the run it replaces. `main` never cancels, so the backend image always reaches the server (see the comment in [ci.yml](../.github/workflows/ci.yml)).
- **Caches.** pnpm's store, Playwright's Chromium (per Playwright version), the Python toolkit's virtualenv and the MCP Registry publisher binary are cached, so a job spends its minutes on tests rather than downloads. The shared steps live in [.github/actions/setup](../.github/actions/setup/action.yml).
- **Timeouts.** Every job has one, so a hung server can't burn hours. Each leaves about half again the job's usual time (`test` 25 min, `e2e` 40, `walkthrough` 25), so a slow runner doesn't cancel a run whose tests all pass. Raise them when a job's usual time creeps up.
- **Vercel.** Only `main` deploys (`git.deploymentEnabled`), and [scripts/vercel-ignore-build.sh](../scripts/vercel-ignore-build.sh) skips the build when nothing the web app or the routing middleware uses has changed since the last deployment. Server-only changes reach the backend through the CI image, not Vercel. CI tests the production build of every ready PR (`E2E_MODE=preview`), so preview links aren't needed; to get one anyway, use **Redeploy** or **Deploy** from the Vercel dashboard.

## Working with it

- Open PRs as drafts while iterating. Mark the PR **ready for review** when you want the browser tests, and wait for `e2e` and `walkthrough` to pass before merging. A draft's green tick only covers `test`.
- A PR that only touches docs gets no checks at all. That is expected; it can be merged without waiting.
- To run everything on any branch, use **Actions → CI → Run workflow**.

## Running the checks without Actions

When Actions has no minutes (every job fails within seconds, with an annotation about payments or the spending limit), run the same jobs on your own machine or in a Claude thread's sandbox:

```sh
git merge origin/main             # test what main will look like after the merge
scripts/ci-local.sh --report      # test, e2e-dev, e2e-preview, e2e-solid, walkthrough
scripts/ci-local.sh e2e-dev       # or just some jobs, without posting anything
```

The script runs each job's steps from [ci.yml](../.github/workflows/ci.yml), starts a throwaway Postgres for `test`, and writes each job's log to `ci-local-logs/<commit>/`. A full run takes about 13 minutes in a 4-CPU Claude sandbox (it took an hour before these changes):

- Jobs run side by side (`--parallel`, one per CPU by default), and the browser suite is split into three shards (`--shards`), each with its own API server, web server, data directory and ports, so no two share state.
- The web app is built once, up front.
- As in CI, the production build gets the whole browser suite and the Vite dev server a smoke test (`pnpm test:e2e:smoke`: the pages, the alpha walkthrough, the reasoner and Validate data). Running all ~490 tests against both took 24 minutes more and caught little: what breaks in only one of them almost always breaks the build.
- The server's test files run in parallel, each worker with its own Postgres database (apps/server/test/setup.ts).
- `settle()` in the browser tests waits until the page has no request in flight for 150 ms, instead of Playwright's `networkidle`, which always waits out 500 ms and took about 40% of a typical test.

With `--report` it records the result for the commit it tested, and refuses to run with uncommitted changes, so the record always describes exactly that commit:

- **Commit statuses** `local/test`, `local/e2e-dev`, `local/e2e-preview`, `local/e2e-solid` and `local/walkthrough`, shown on the pull request, wherever `gh` may post them (your own machine, the Mac).
- **`ci-local-logs/<commit>/summary.md`**, a table of the same results. A Claude thread's GitHub access can't post statuses, so the thread posts this summary on the pull request as a comment instead.

Merge a pull request only when its head commit, after merging current `main`, has all five jobs passing in one of those records (and the external review has approved). Push nothing after the run, or run again.

A private repository on GitHub's free plan has no branch protection, so GitHub doesn't enforce any of this: it is the rule we follow.

Deploys also come from Actions: the `image` job builds the backend image the server pulls, and [vercel-deploy.yml](../.github/workflows/vercel-deploy.yml) deploys the web app. Without minutes, deploy by hand after a merge: `vercel deploy --prod` from a checkout of `main` (signed in to the jeswr1 team), and build and push `ghcr.io/standards-concord/standards-concord:latest` (`docker buildx build --platform linux/amd64 --push`).

## Option: a self-hosted runner

Jobs on a self-hosted runner use no GitHub minutes. This is an option, not something that is set up.

**Where.** The backend VM (`Standard_B2ats_v2`, 1 GB of RAM) is too small to run the browser tests next to the live server: a Playwright run needs 2 to 3 GB and would push the live API into swap. Choose one of:

1. **A second VM just for CI** (recommended if minutes run short). `Standard_B2als_v2` (2 vCPU, 4 GB) in the same resource group, billed against the student credit (roughly a dollar a day while it is running). Stop it when nobody is working (`az vm deallocate -g concord -n concord-runner`) and it costs only its disk.
2. **The backend VM, resized** to `Standard_B2als_v2` (see [deploy.md](deploy.md#cost)), running only the quick `test` job. Keep `e2e` on GitHub's runners.
3. **A Mac or other machine that is usually on.** Free, and fast, but jobs queue whenever it is asleep.

**Setup outline** (Ubuntu VM, as an unprivileged user):

1. In the repository (or organisation) on GitHub: **Settings → Actions → Runners → New self-hosted runner → Linux x64**. GitHub shows a download command and a one-time registration token. Use that token in step 3; it expires after an hour and is not needed again.
2. Install what the jobs expect: Node 22 with corepack, Java 21, Python 3.12, `uv`, `ffmpeg`, Docker (for the `image` job), and the Playwright system libraries (`npx playwright install-deps chromium`).
3. Download the runner into `~/actions-runner`, then `./config.sh --url https://github.com/<owner>/standards-concord --token <token> --labels concord --unattended`, then `sudo ./svc.sh install && sudo ./svc.sh start` so it survives reboots.
4. In [ci.yml](../.github/workflows/ci.yml), change `runs-on: ubuntu-latest` to `runs-on: [self-hosted, concord]` for the jobs you want to move. Because jobs share the machine, give each its own ports (the e2e suite already reads `E2E_API_PORT` and `E2E_WEB_PORT`) or run one job at a time (one runner process does that by default).

**Security.** Only use a self-hosted runner while the repository is **private**. On a public repository, anyone can open a pull request whose workflow runs on your machine. If the repository goes public, move the jobs back to GitHub's runners, which are then free.
