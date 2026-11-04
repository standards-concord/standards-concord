# Concord app check

Test your application against every change proposed to an ontology on Concord, before the change is merged.

Each run:

1. asks Concord which change requests are open and which of them this app hasn't tested at their current version;
2. downloads the **working draft** and runs your tests. If they fail there, it stops and fails the job, because a broken baseline says nothing about the changes;
3. for each open change request, downloads the ontology **as it would be after that change** and runs your tests again;
4. reports each result to Concord, where it shows on the change request's page with a link to the run.

When a change, or the working draft it would merge into, moves on, Concord asks for it to be tested again. Approved changes keep being tested until they are merged, because a failure can still stop the merge.

The job fails if the working draft breaks the app, or if any proposed change couldn't be tested (a download failed or the tests timed out). Set `fail-on-break` to also fail it when a change breaks the app.

## Autopilot

On the **App checks** page of the ontology (Changes → App checks), turn on autopilot for your app and Concord says yes for you when your apps pass: it approves the change in review (if your role's approvals count for that level of change) and votes yes when it goes to a vote. You choose which levels it may say yes to (patch and minor by default, not breaking changes).

- It acts only on **verified** results. A result is verified when it comes from a GitHub Actions run in the app's repository that GitHub vouches for, or when you report it yourself while signed in to Concord. For GitHub runs:
  - the job needs `permissions: id-token: write`, and the app's GitHub repository must be set on Concord;
  - the run must be started by a schedule, a manual run, a push or a repository dispatch, not by a pull request;
  - its workflow must live in that repository;
  - the repository's id is pinned by the first verified run.

  Each change result from such a run proves it belongs to the run with that change's own key, which only the job holding GitHub's proof gets back and which works for six hours. That is Concord's key lifetime: long enough for most test runs, and the same as GitHub-hosted runners' job limit. A longer run (a self-hosted runner can run for days) gets fresh keys by sending its working-draft result again with a new OIDC token. Results reported with only the app token still show, but autopilot doesn't act on them, and they can't replace a verified result for the same version. So a leaked token can't get anything approved or undo what a verified run found.
- It says yes only once every one of your apps with autopilot on has passed both the current working draft and the current version of the change. Results count only from the run since which the app has passed the working draft without a break, with the same app commit, so a result from before the app broke, or from another version of it, never comes back. Those changes are tested again.
- It speaks only where your say counts: it approves only if your role's approvals count for that level of change, and votes (yes or no) only if your role votes on it.
- If an app fails, the yes is taken back, and if you choose, autopilot votes no in a vote. While an app fails the working draft itself, its results say nothing about the changes, so autopilot says nothing at all.
- A yes counts only for the version it was given for. If the change is edited or the working draft moves on, it stops counting until your app passes again.
- Anything that removes the basis for a yes takes it back: a failure or error, turning autopilot off, deleting the app, connecting another autopilot app that hasn't reported yet, or the ontology's owner turning autopilot off in its governance policy. A taken-back yes stays on the record, marked withdrawn; it never brings an older review or vote back into force.
- If an approved change loses an autopilot yes it needed, even while it is being merged, it goes back to review (or its vote reopens) instead of being merged.
- Once you review or vote on a version of a change yourself, at any stage, autopilot takes back anything it said for you on that version and leaves the change to you.

## Set up

1. On the ontology's **App checks** page, connect your app. Copy the token (it starts `cna_`) into a repository secret named `CONCORD_APP_TOKEN`.
2. Add `.github/workflows/concord.yml` (the page fills this in for you):

```yaml
name: Concord ontology checks
on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:
jobs:
  concord:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write   # lets GitHub vouch for the run, so autopilot can trust it
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: jeswr/standards-concord/actions/app-check@main
        with:
          concord-url: https://standards-concord.vercel.app
          token: ${{ secrets.CONCORD_APP_TOKEN }}
          test-command: npm test
          # ontology-file: data/ontology.ttl
```

## The token

The token identifies one app on one ontology. It can start runs, report results, and download what each change open for checks (in review, in a vote, or approved) would produce: the change's edits plus the provenance the merge adds (the author's name, the date and the change number), which any member of the ontology can see. It can't read drafts, rejected or withdrawn changes, or anything else that needs signing in.

Replace it on the App checks page at any time; the old one stops working at once. It also stops working when the app is removed, when the ontology's owners or stewards disconnect the app, or when the person who connected it is no longer a member of the ontology.

## How your tests see the ontology

Either give `ontology-file`, the path of the copy your app already reads, and it is swapped for each version and put back afterwards; or read these environment variables in your tests:

| Variable | Value |
| --- | --- |
| `CONCORD_ONTOLOGY_FILE` | Path of the version under test |
| `CONCORD_ONTOLOGY_URL` | Where that version can be downloaded |
| `CONCORD_TARGET` | `baseline`, or `cr-<number>` for a change request |
| `CONCORD_CHANGE_REQUEST` | The change request number (unset for the baseline) |
| `CONCORD_REVISION` | Fingerprint of the version under test |

## Inputs

| Input | Default | |
| --- | --- | --- |
| `token` | (required) | The app token. |
| `test-command` | (required) | The command that tests your app. Exit code 0 means it passed. |
| `concord-url` | `https://standards-concord.vercel.app` | Where Concord runs. |
| `ontology-file` | | Copy of the ontology to swap for each version. |
| `format` | `turtle` | `turtle`, `jsonld`, `rdfxml`, `ntriples`, `manchester`, `linkml` or `shacl`. |
| `working-directory` | `.` | Where to run the tests. |
| `max-changes` | `20` | Most change requests to test in one run, so a run's length stays bounded. The rest wait for the next run, first come first served: a change waits from when the app last tested it, or from when it was proposed if never tested. Without an app commit, results only count for the run that made them, so a run that has to leave changes out fails the job: set a commit or raise the limit. |
| `recheck` | `false` | Test every open change again. |
| `timeout-minutes` | `15` | Per test run; a run that times out is stopped, with everything it started, and reported as an error, not a failure. |
| `share-output` | `false` | Send the last lines of a failing run to Concord. Off by default so nothing from your logs leaves GitHub. |
| `fail-on-break` | `false` | Also fail the job when a proposed change breaks the app. |

Outputs: `checked` (how many change requests were tested) and `failed` (their numbers, comma-separated).

## Other CI systems

The action is one Node 20+ script with no dependencies. Run it anywhere:

```sh
CONCORD_URL=https://standards-concord.vercel.app \
CONCORD_APP_TOKEN=cna_... \
CONCORD_TEST_COMMAND="npm test" \
CONCORD_ONTOLOGY_PATH=data/ontology.ttl \
node run.mjs
```

Set `CONCORD_RUN_URL` and `CONCORD_COMMIT` so results link back to your run. Without `CONCORD_COMMIT` the script uses the checkout's git commit when the working tree is clean. With no commit at all, Concord can't tell versions of your app apart, so results only count from the run whose working-draft result is current, and every run tests every open change again, up to `max-changes`. If more are open than that, the job fails, because the changes left out have no result that counts.

Outside GitHub Actions, runs aren't verified, so autopilot doesn't act on them; the results still show on each change.

## API

The script uses two endpoints, authenticated with `Authorization: Bearer cna_…`:

- `GET /api/app-checks/pending?commit=<app commit>` starts a run. Changes already tested by this same app commit are left out; without `commit`, every open change is listed. The reply to the run's working-draft result carries `targets` again: what the run should test now that its draft result is in, longest waiting first (since the app last tested it, or since it was proposed). Use that list. It returns the run's `attempt` number and lists the baseline and open change requests, each with a `revision` and a `source` path. `GET /api/change-requests/:id/proposed?format=turtle` is the ontology after a change. Send the app token with it, as with the other calls: change requests are only for signed-in people and the CI of apps connected to that ontology.
- `POST /api/app-checks` with `{ target: "baseline" | <change request id>, revision, attempt, outcome: "passed" | "failed" | "error", summary?, runUrl?, commit?, oidc? }`. `oidc`, sent with the working-draft result, is a GitHub Actions OIDC token for the audience `concord-app-check:<app id>`. If it checks out, the run is verified, and the reply says `verified: true` and carries `runKeys`, one key per change in the run, valid until `runKeysUntil` (six hours). To check out, the token must be:
  - signed by GitHub, with numeric `iat`, `exp` and an optional `nbf`, valid for at most an hour;
  - from the app's repository (name and pinned id), with its workflow in that repository;
  - triggered by an accepted event;
  - for the reported commit (`sha` is required);
  - not used before (recorded per issuer and token id in the database). Retrying the same report with the same token is allowed.

  Send each change's key as `runKey` with its result: only results that carry their own change's key count as verified. Repository dispatch is accepted because only people with write access to the repository can send one, the same as a push, and it is how a future Concord GitHub App could start runs straight away. The app's owner can also call both endpoints signed in, without the token, by sending `appId`; those runs count as verified. A run may only report the targets and revisions it was given, and must report the working draft first: change results are tied to that run's working-draft pass and app commit, and count only while that commit's pass is the one in force. If the reply for the working draft says `stale`, a newer run has taken over and this one should stop. The reply says whether the result was `stale` (the change moved on while it was being tested, or a newer run already reported) or a `replay` of one already recorded, and what autopilot did. Within a revision, a newer attempt's result replaces an older one's; a run can't report two different outcomes for one target.
