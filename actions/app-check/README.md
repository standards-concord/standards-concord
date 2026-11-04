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

- It says yes only once every one of your apps with autopilot on has passed both the current working draft and the current version of the change.
- If an app fails, the yes is taken back, and if you choose, autopilot votes no in a vote. While an app fails the working draft itself, its results say nothing about the changes, so autopilot says nothing at all.
- A yes counts only for the version it was given for. If the change is edited or the working draft moves on, it stops counting until your app passes again.
- Anything that removes the basis for a yes takes it back: a failure or error, turning autopilot off, deleting the app, connecting another autopilot app that hasn't reported yet, or the ontology's owner turning autopilot off in its governance policy. A taken-back yes stays on the record, marked withdrawn; it never brings an older review or vote back into force.
- If an approved change loses an autopilot yes it needed, even while it is being merged, it goes back to review (or its vote reopens) instead of being merged.
- Once you review or vote on a version of a change yourself, at any stage, autopilot leaves that change to you.

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
| `max-changes` | `20` | Most change requests to test in one run; the rest wait for the next. |
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

Set `CONCORD_RUN_URL` and `CONCORD_COMMIT` so results link back to your run.

## API

The script uses two endpoints, authenticated with `Authorization: Bearer cna_…`:

- `GET /api/app-checks/pending` starts a run. It returns the run's `attempt` number and lists the baseline and open change requests, each with a `revision` and a `source` path. `GET /api/change-requests/:id/proposed?format=turtle` is the ontology after a change (public, no token needed).
- `POST /api/app-checks` with `{ target: "baseline" | <change request id>, revision, attempt, outcome: "passed" | "failed" | "error", summary?, runUrl?, commit? }`. The reply says whether the result was `stale` (the change moved on while it was being tested, or a newer run already reported) or a `replay` of one already recorded, and what autopilot did. Within a revision, a newer attempt's result replaces an older one's; a run can't report two different outcomes for one target.
