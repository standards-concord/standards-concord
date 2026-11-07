# Moving Concord from the VM to Vercel

The runbook for moving Concord's data from the Azure VM (SQLite and a git repository per ontology) into Neon Postgres, where Vercel's functions and the database-backed ontology store use it. The VM stays as it is, read-only, until Vercel is verified, and can take over again at any point before then.

## The tool

`apps/server/src/migrate/cli.ts` copies, checks and copies back. It writes to (or reads from) the Postgres database named by `DATABASE_URL`.

| Command | What it does |
| --- | --- |
| `copy --from <data dir>` | Copies every document from `<data dir>/concord.sqlite` byte for byte (with its creation time), imports every object of every repository under `<data dir>/ontologies`, then runs `verify`. It can run again: documents are replaced and objects are added once. |
| `verify --from <data dir>` | Checks the copy without changing it. It checks that every document matches its source. It checks that every commit a record names (the draft, forks, releases, change requests and refs) has its whole history in the database, with each object rehashed, and that `git fsck --strict` accepts it. It checks that every object in each source repository was imported, that release tags sit on their releases' commits, and that fork branches match. Then it records the `ontology-import` marker. |
| `export --to <empty dir>` | Writes the database back out as `concord.sqlite` and a git repository per ontology, for rolling back to the VM. |

Run it as `node --import tsx src/migrate/cli.ts …` from `apps/server`. Anything it couldn't settle but didn't treat as an error, such as a record naming a commit that isn't in the history, it prints as a note.

## Guarantees in the app

- **No serving an unchecked import.** The database store won't start against a database that has ontologies but no verified `ontology-import` marker. A new, empty database is marked as having nothing to import.
- **Read-only switch.** With `CONCORD_READ_ONLY=true`, the server answers reads but refuses every change. It returns 503 with `Retry-After: 300` for anything but GET, HEAD and OPTIONS, and its store refuses writes. It runs no timers and no start-up writes, so nothing changes the data while it is copied.

## Before the day

1. Steps 4 and 5 are merged and deployed to a Vercel preview that uses a Neon branch. Scheduled work runs without per-minute timers, and the API runs as functions.
2. The VM's keys are in Vercel's production environment variables, pasted by Jesse from the Mac and never shown.
3. Rehearse against a scratch Neon branch while the VM is still live. Run `copy --from /data` on the VM in a one-off container from the running image, with the tool's source mounted over the image's, `DATABASE_URL` pointing at the branch and the data volume mounted read-only. Then open the preview against that branch and check the ontologies, histories, releases, forks and sign-in. Note how long the copy took, because the read-only window will last about that long.

## On the day

Each write to the VM needs Jesse's go, written in the Mac thread.

1. **Read-only.** Set `CONCORD_READ_ONLY=true` in the VM's `app.env` and restart the container. Check that a POST returns 503 and that the site still reads.
2. **Copy.** Run `copy --from /data` against production Neon, as in the rehearsal. It must end with `Verified:` and no unexpected notes.
3. **Deploy.** Deploy to Vercel production with the middleware sending the API to the functions instead of the VM.
4. **Verify on Vercel.** Sign in, open each ontology, compare the history and releases with the VM, make an edit on a scratch ontology, and check that the daily cron ran and that a release publishes to GitHub.
5. **Keep the VM** read-only and untouched until Jesse agrees Vercel is working. Then stop it (and later delete it).

## Rolling back

- **Before anything is written on Vercel:** point the middleware back at the VM (`BACKEND_URL`), redeploy, and take `CONCORD_READ_ONLY` off the VM. Nothing was lost.
- **After writes on Vercel:** set Vercel read-only (`CONCORD_READ_ONLY=true`), run `export --to /restore` into an empty directory, and swap it in as the VM's data volume. Then start the VM writable and point the middleware back at it. The git store's start-up sync checks out each draft and makes release tags, as it does after a crash.
