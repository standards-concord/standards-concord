# Where ontologies' history lives

Every ontology has a git history: the working draft is `ontology.ttl` on `main`, and each release is committed under `releases/<version>/` and tagged `v<version>`. Concord can keep that history in one of two places, chosen by `ONTOLOGY_STORE`:

| `ONTOLOGY_STORE` | Where | Used by |
|---|---|---|
| `git` (the default without Postgres) | A git repository per ontology under the data directory, driven by the `git` command line (`services/ontologyStore.ts`) | The VM, local development |
| `db` (the default with `DATABASE_URL`) | git's own objects stored in the database (`services/gitdb.ts`, `services/ontologyStoreDb.ts`) | Vercel, which has no disk and no `git` |

Both backends behave the same way to the rest of the server, which uses only the `ontologyStore` interface.

## The database store

- **Blobs, trees, commits and annotated tags** are stored in the `gitObjects` collection, keyed by their real git SHA-1. They are serialised exactly as git does it (byte lengths, git's tree order, git's commit and tag layout), so a commit has the same id in Concord, in a git clone and on GitHub. Objects never change and are never deleted.
- **The working draft** is the commit named by the `draft-head:<slug>` row, as with the git store. `advanceTo` moves it in one transaction with the caller's own checks and writes, and only forward.
- **Fork branches** are rows in `gitRefs` (`refs/heads/forks/<slug>`). A fork's branch moves in the same transaction as the fork's record.
- **There are no pins, syncs or claims.** The git store needs them to keep a repository on disk in line with the database, and to stop `git gc` from deleting commits. The database store has nothing to keep in line and nothing that collects garbage.
- **A demo reset** empties the whole database, histories included, in one transaction.

## What isn't built yet

- **Publishing to GitHub from the database store.** This will be an outbox job using GitHub's Git Data API (step 3b of the move to Vercel). Until it lands, a release on the `db` backend is not pushed to GitHub, and the server logs a warning. No ontology is configured to publish today.
- **Moving the VM's repositories into the database.** This will be an import with full verification, plus a reverse export for rollback (step 3c).

## Tests

CI runs the server suite twice, once on each backend. The tests that exercise the git store's own machinery (pins, syncs, the claim on the repositories) run only with `ONTOLOGY_STORE=git`. `test/gitdb.test.ts` checks the object ids against git itself. `test/ontologyStoreDb.test.ts` checks the database store's guarantees, and that it answers history questions exactly as the git store does. With `TEST_DATABASE_URL` set, both run on a real Postgres server.
