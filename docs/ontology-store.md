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

## Publishing to GitHub from the database store

The git store pushes a release with `git push`. The database store has no repository to push, so it rebuilds the history on GitHub through the Git Data API instead (`githubPublisher.ts`), run as an outbox (`githubOutbox.ts`):

- **The job is recorded with the release.** Publishing a release writes a `github-publish:<ontology>` row in the same transaction, naming the repository and the commit main should reach. A newer release moves that commit forward. A worker runs the job straight after the release, and every governance tick runs any job that is due.
- **One worker at a time.** A worker takes the job's lease (a token and an expiry) in a transaction, renews it at every checkpoint, and changes the job only while it still holds it. GitHub is never called inside a transaction.
- **Approval governs every upload, not only the first.** Before each write the worker checks again that the ontology still publishes to the same repository, that the token is set, that nothing is held for a steward's approval, that the history was made under the approval rules, and that publishing isn't blocked by a withdrawal. If any of that fails, the job is cancelled and nothing more is sent.
- **A withdrawal blocks what it must.** If a use case that was ever public is withdrawn (or made non-public) while a published release isn't on GitHub yet, that ontology is never published to GitHub again: the release's files were written with the use case's consent at the time, and history can't change. A use case that was only ever private or group-only can't be in a release, so withdrawing it blocks nothing. The block is written in the withdrawal's own transaction and checked before every write, so only a write already on its way still goes. Once every release is on GitHub, a withdrawal blocks nothing, because later releases are prepared without the use case. As with the git store, what is already on GitHub can't be recalled.
- **Same ids as Concord.** Blobs, trees, commits and tags are sent parents first, and each id GitHub returns must equal Concord's. Release tags are annotated by `Concord <concord@localhost>` at the release's publication time, so they are the same object every time.
- **Refs move only from what was read.** main moves with a GraphQL `updateRefs` call that names the value it was read at, so a main someone moved meanwhile, for example by a force-push back, refuses the update instead of being overwritten. The job also keeps where main was last confirmed on GitHub. A main found behind that, at the start of a later run, was moved back by someone, so the job is quarantined instead of moving main forward again. A tag that names something else stops the job before main moves. `updateRefs` only points refs at commits, so once main is in place each release tag is made, its object and then its ref (with REST, create-only: an existing ref is never changed). A run that stops part way keeps main and the tags it finished, and the next run makes the rest. At the end every ref the target needs is read back, including ones that didn't move. If GitHub didn't answer, the job is tried again only if main is still where it was read. A main anywhere else stops the job, and when GitHub refuses, its reason is recorded.
- **Rate limits.** Writes count against an hourly budget shared by every ontology (`GITHUB_PUBLISH_WRITES_PER_HOUR`, default 400), each in the hour it is made in. Uploads leave the hour's last write for moving main, so a run that runs out part way usually moves main forward along the draft's own line to the last commit it sent in full. That isn't guaranteed: another job can take that last write first, and the run then keeps nothing. Progress is only kept where main can point, so a single commit, or a merge, that needs more new objects than an hour's budget can't be published until the budget is raised. GitHub's own rate limits and errors pause the job until GitHub says to try again.
- **Quarantine.** A job publishing again won't fix stops with its reason and leaves other ontologies alone. That covers a main on GitHub with commits Concord doesn't have, an id that doesn't match, a tag that names something else, and an empty repository (GitHub's API can't add history to one, so push it once with git). A newer release starts it again.
- **Done means read back.** Only once GitHub's refs are where Concord put them does each release get its GitHub link.

No ontology is configured to publish today.

## What isn't built yet

- **Moving the VM's repositories into the database.** This will be an import with full verification, plus a reverse export for rollback (step 3c).

## Tests

CI runs the server suite twice, once on each backend. The tests that exercise the git store's own machinery (pins, syncs, the claim on the repositories) run only with `ONTOLOGY_STORE=git`. `test/gitdb.test.ts` checks the object ids against git itself. `test/ontologyStoreDb.test.ts` checks the database store's guarantees, and that it answers history questions exactly as the git store does. `test/githubPublisher.test.ts` publishes to a stand-in for GitHub that has git build each object from the parts sent, in a bare repository, and checks the outbox's leases, approval checks and quarantine. With `TEST_DATABASE_URL` set, all three run on a real Postgres server.
