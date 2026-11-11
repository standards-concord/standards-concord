# Moving Concord from the VM to Vercel

The runbook for moving Concord's data from the Azure VM (SQLite and a git repository per ontology) into Neon Postgres, where Vercel's functions and the database-backed ontology store use it. The VM stays as it is, read-only, until Vercel is verified, and can take over again at any point before then.

## The tool

`apps/server/src/migrate/cli.ts` copies, checks and copies back. It writes to (or reads from) the Postgres database named by `DATABASE_URL`.

| Command | What it does |
| --- | --- |
| `copy --from <data dir> [--pods <Solid server data dir>]` | Copies every document from `<data dir>/concord.sqlite` byte for byte (with its creation time and order), imports every object of every repository under `<data dir>/ontologies` (recording each repository's refs) and every private file under `<data dir>/private` (kept for accounts with no pod), then runs `verify`. With `--pods`, it also takes what Concord kept in the pods it made on the VM's Solid server (each such pod's `concord/` folder, see below) as private files. It refuses to run without `--pods` when any account has such a pod, so nobody's data is left behind. Every ontology must have its repository. It can run again: documents are replaced, objects are added once (a damaged copy is replaced), and fork branches are set exactly. |
| `verify --from <data dir> [--pods <Solid server data dir>]` | Checks the copy without changing it, after forgetting any earlier verification. It checks that every document matches its source, in the same order. It checks that every ontology has a repository and a working draft, and that every commit a record names (the draft, forks, releases, change requests including the head they were triaged at) and every ref of its repository has its whole history in the database, with each object rehashed. Every object in each repository, reachable or not, must be stored byte for byte, and `git fsck --strict` must accept them all. Release tags must sit on their releases' commits, the fork branches must be exactly those the records and repository call for, and every private file must be stored byte for byte. Only then does it record the `ontology-import` marker. |
| `export --to <empty dir>` | Writes the database back out as `concord.sqlite`, a git repository per ontology and the private files (readable by the server only), for rolling back to the VM: the draft, fork branches, and the tags, branches and pins the repository had at import, with everything they reach. Objects nothing reached at import (git would collect them anyway) aren't written. |

Run it as `node --import tsx src/migrate/cli.ts …` from `apps/server`. Anything it couldn't settle but didn't treat as an error, such as a record naming a commit that isn't in the history, it prints as a note.

## The pods on the VM

The VM runs a Solid server (the Community Solid Server, at `pods.…sslip.io`) and made a pod there for people who signed in with GitHub, Google or the demo. Concord kept their private data (testing records, query drafts, chats) in that pod's `concord/` folder. Vercel has no such server, so at the cutover that data moves into the database with `--pods`:

- **Google, GitHub and demo accounts:** their private data then lives in the database, like any account with no pod.
- **Solid accounts:** what was kept for them moves into their own pod the next time they sign in with Solid (`carryIntoOwnPod` in `services/solid.ts`). Each document is created there, never over one already there (it goes beside it as `<name>.from-concord-<n>`), and only then removed from the database. A copy an earlier try made but couldn't remove here is recognised by its content. If anything fails, the rest is tried again at their next sign-in. Their testing record is copied there afresh.

`--pods` takes the Solid server's data directory: on the VM, the `solid-data` docker volume. A pod at `https://pods.…/alice/` is the folder `alice/` there. Files ending `.acl` or `.meta` are skipped, and the `$.<ext>` the server adds to some names is taken off. A pod the database names but the folder doesn't have stops the copy, which usually means the wrong directory was given. So does a pod folder, or anything in it, that is reached through a link: it may hold someone else's files.

## Guarantees in the app

- **No serving an unchecked import.** The database store won't start against a database that has ontologies but no verified `ontology-import` marker. The marker belongs to the database it was recorded in: copy and export leave it out, and copy, import and verify each remove it before they start. A new, empty database is marked as having nothing to import.
- **Read-only switch.** With `CONCORD_READ_ONLY=true`, the server answers reads but refuses every change. It returns 503 with `Retry-After: 300` for anything but GET, HEAD and OPTIONS, and its store refuses writes. It runs no timers and no start-up writes, and writes nothing outside the database either: nothing goes to pods or private files (a tester's record waits for their next visit), and the git repositories are left as they are, pins and refs included. So nothing changes the data while it is copied.

## Before the day

1. **Done 2026-11-11:** steps 4 and 5 are merged and ran on a Vercel preview with its own database (the free Neon database `concord-preview`, whose variables are `PREVIEW_*`, Preview only; Neon's production database was never touched). The preview at 5542887 served the API from the function in London (lhr1). It seeded the demo, ran the reasoner, SPARQL, an agent's MCP calls (`search_terms`, `validate_data`), a simulated live call through to its summary, the daily cron (refused without its secret), the 4 MB body limit and the welcome videos. Cold starts took 4 to 5 s, and warm requests 0.3 to 0.7 s. It found two bugs that would have broken the cutover, both fixed: the daily cron declared twice (#135) and the middleware forwarding the API to the VM (#136). Full results: `/mnt/project-files/step5d-preview/results.md`.
   - A preview of the function while `BACKEND_URL` is set for Preview needs `CONCORD_API=function` at build time and at run time (`vercel deploy -b CONCORD_API=function -e CONCORD_API=function`), and its own database URL as `DATABASE_URL`.
2. **Step 5e is merged (#123):** people who sign in with Solid keep their private data in their own pod, written as them. Until then the function would keep their private data in the database, against the agreed policy (Google and GitHub accounts' private data goes to the database; Solid accounts' goes to their pod). No cutover before it.
3. **The pod copy is merged:** `copy` takes the VM's pods with `--pods`, and Solid accounts' data moves into their own pods at sign-in (see [The pods on the VM](#the-pods-on-the-vm)). Without it, everything Concord kept in the VM's pods would be lost when the VM goes. No cutover before it.
4. The VM's keys are in Vercel's production environment variables, pasted by Jesse from the Mac and never shown.
5. Rehearse against a scratch database while the VM is still live: `concord-preview`, emptied first (the preview seeded it, and `copy` replaces documents but doesn't remove extras, so `verify` would refuse), or a fresh branch of it. Run `copy --from /data --pods /pods` on the VM in a one-off container from the running image, with the tool's source mounted over the image's, `DATABASE_URL` pointing at that database, the data volume mounted read-only at `/data` and the `solid-data` volume mounted read-only at `/pods`. Check that the private file count includes the pods' files. Then open a preview against that database and check the ontologies, histories, releases, forks, sign-in, and a GitHub account's testing record. Note how long the copy took, because the read-only window will last about that long.

## On the day

Each write to the VM needs Jesse's go, written in the Mac thread.

1. **Read-only.** Set `CONCORD_READ_ONLY=true` in the VM's `app.env` and restart the container. Check that a POST returns 503 and that the site still reads. The Solid server stays up, but Concord, which writes the `concord/` folders, no longer writes anything.
2. **Copy.** Run `copy --from /data --pods /pods` against production Neon, as in the rehearsal. It must end with `Verified:` and no unexpected notes.
3. **Deploy.** Remove `BACKEND_URL` from Vercel's production variables (or set `CONCORD_API=function`) and redeploy, so the build makes the API function instead of forwarding to the VM ([deploy.md](deploy.md#the-api-as-a-vercel-function)).
4. **Verify on Vercel.** Sign in, open each ontology, compare the history and releases with the VM, make an edit on a scratch ontology, and check that the daily cron ran and that a release publishes to GitHub.
5. **Keep the VM** read-only and untouched until Jesse agrees Vercel is working. Then stop it (and later delete it).

## Rolling back

- **Before anything is written on Vercel:** point the middleware back at the VM (`BACKEND_URL`), redeploy, and take `CONCORD_READ_ONLY` off the VM. Nothing was lost.
- **After writes on Vercel:** set Vercel read-only (`CONCORD_READ_ONLY=true`), run `export --to /restore` into an empty directory, and swap it in as the VM's data volume. Then start the VM writable and point the middleware back at it. The git store's start-up sync checks out each draft and makes release tags, as it does after a crash.
