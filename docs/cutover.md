# Moving Concord from the VM to Vercel

The runbook for moving Concord's data from the Azure VM (SQLite and a git repository per ontology) into Neon Postgres, where Vercel's functions and the database-backed ontology store use it. The VM stays as it is, read-only, until Vercel is verified, and can take over again at any point before then.

## The tool

`apps/server/src/migrate/cli.ts` copies, checks and copies back. It writes to (or reads from) the Postgres database named by `DATABASE_URL`.

| Command | What it does |
| --- | --- |
| `copy --from <data dir>` | Copies every document from `<data dir>/concord.sqlite` byte for byte (with its creation time and order), imports every object of every repository under `<data dir>/ontologies` (recording each repository's refs) and every private file under `<data dir>/private` (kept for accounts with no pod), then runs `verify`. Every ontology must have its repository. It can run again: documents are replaced, objects are added once (a damaged copy is replaced), and fork branches are set exactly. |
| `verify --from <data dir>` | Checks the copy without changing it, after forgetting any earlier verification. It checks that every document matches its source, in the same order. It checks that every ontology has a repository and a working draft, and that every commit a record names (the draft, forks, releases, change requests including the head they were triaged at) and every ref of its repository has its whole history in the database, with each object rehashed. Every object in each repository, reachable or not, must be stored byte for byte, and `git fsck --strict` must accept them all. Release tags must sit on their releases' commits, the fork branches must be exactly those the records and repository call for, and every private file must be stored byte for byte. Only then does it record the `ontology-import` marker. |
| `export --to <empty dir>` | Writes the database back out as `concord.sqlite`, a git repository per ontology and the private files (readable by the server only), for rolling back to the VM: the draft, fork branches, and the tags, branches and pins the repository had at import, with everything they reach. Objects nothing reached at import (git would collect them anyway) aren't written. |

Run it as `node --import tsx src/migrate/cli.ts …` from `apps/server`. Anything it couldn't settle but didn't treat as an error, such as a record naming a commit that isn't in the history, it prints as a note.

## Guarantees in the app

- **No serving an unchecked import.** The database store won't start against a database that has ontologies but no verified `ontology-import` marker. The marker belongs to the database it was recorded in: copy and export leave it out, and copy, import and verify each remove it before they start. A new, empty database is marked as having nothing to import.
- **Read-only switch.** With `CONCORD_READ_ONLY=true`, the server answers reads but refuses every change. It returns 503 with `Retry-After: 300` for anything but GET, HEAD and OPTIONS, and its store refuses writes. It runs no timers and no start-up writes, and writes nothing outside the database either: nothing goes to pods or private files (a tester's record waits for their next visit), and the git repositories are left as they are, pins and refs included. So nothing changes the data while it is copied.

## Before the day

1. Steps 4 and 5 are merged and deployed to a Vercel preview that uses a Neon branch. Scheduled work runs without per-minute timers, and the API runs as functions.
1. **Step 5e is merged:** people who sign in with Solid keep their private data in their own pod, written as them. Until then the function would keep their private data in the database, against the agreed policy (Google and GitHub accounts' private data goes to the database; Solid accounts' goes to their pod). No cutover before it.
2. The VM's keys are in Vercel's production environment variables, pasted by Jesse from the Mac and never shown.
3. Rehearse against a scratch Neon branch while the VM is still live. Run `copy --from /data` on the VM in a one-off container from the running image, with the tool's source mounted over the image's, `DATABASE_URL` pointing at the branch and the data volume mounted read-only. Then open the preview against that branch and check the ontologies, histories, releases, forks and sign-in. Note how long the copy took, because the read-only window will last about that long.

## On the day

Each write to the VM needs Jesse's go, written in the Mac thread.

1. **Read-only.** Set `CONCORD_READ_ONLY=true` in the VM's `app.env` and restart the container. Check that a POST returns 503 and that the site still reads.
2. **Copy.** Run `copy --from /data` against production Neon, as in the rehearsal. It must end with `Verified:` and no unexpected notes.
3. **Deploy.** Remove `BACKEND_URL` from Vercel's production variables (or set `CONCORD_API=function`) and redeploy, so the build makes the API function instead of forwarding to the VM ([deploy.md](deploy.md#the-api-as-a-vercel-function)).
4. **Verify on Vercel.** Sign in, open each ontology, compare the history and releases with the VM, make an edit on a scratch ontology, and check that the daily cron ran and that a release publishes to GitHub.
5. **Keep the VM** read-only and untouched until Jesse agrees Vercel is working. Then stop it (and later delete it).

## Rolling back

- **Before anything is written on Vercel:** point the middleware back at the VM (`BACKEND_URL`), redeploy, and take `CONCORD_READ_ONLY` off the VM. Nothing was lost.
- **After writes on Vercel:** set Vercel read-only (`CONCORD_READ_ONLY=true`), run `export --to /restore` into an empty directory, and swap it in as the VM's data volume. Then start the VM writable and point the middleware back at it. The git store's start-up sync checks out each draft and makes release tags, as it does after a crash.
