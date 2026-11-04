# Concord app check

Test your application against every change proposed to an ontology on Concord, before the change is merged.

Each run:

1. asks Concord which change requests are open and which of them this app hasn't tested at their current version;
2. downloads the **working draft** and runs your tests. If they fail there, it stops and fails the job, because a broken baseline says nothing about the changes;
3. for each open change request, downloads the ontology **as it would be after that change** and runs your tests again;
4. reports each result to Concord, where it shows on the change request's page with a link to the run.

When a change, or the working draft it would merge into, moves on, Concord asks for it to be tested again.

## Autopilot

On the **App checks** page of the ontology (Changes → App checks), turn on autopilot for your app and Concord says yes for you when your apps pass: it approves the change in review (if your role's approvals count for that level of change) and votes yes when it goes to a vote. You choose which levels it may say yes to (patch and minor by default, not breaking changes). If an app fails, any autopilot yes is taken back, and if you choose, autopilot votes no. It waits until all of your apps with autopilot on have tested the current version, does nothing while an app fails the working draft, and never overrides a review or vote you made yourself. An ontology's owner can turn autopilot off in its governance policy.

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
| `timeout-minutes` | `15` | Per test run; a run that times out is reported as an error, not a failure. |
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

- `GET /api/app-checks/pending` lists the baseline and open change requests, each with a `revision` and a `source` path. `GET /api/change-requests/:id/proposed?format=turtle` is the ontology after a change (public, no token needed).
- `POST /api/app-checks` with `{ target: "baseline" | <change request id>, revision, outcome: "passed" | "failed" | "error", summary?, runUrl?, commit? }`. The reply says whether the result was `stale` (the change moved on while it was being tested) and what autopilot did.
