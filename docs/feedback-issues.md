# Public feedback summaries as GitHub issues

Testers can choose to post a short summary of their feedback as a GitHub issue on this repository. An hourly scheduled Claude session triages those issues (see [Hourly triage](#hourly-triage)).

## What is posted

Nothing is posted by default. Feedback stays on the server, readable only by administrators.

To post anything, a tester ticks **Also post a short public summary as a GitHub issue** on the feedback page and writes a summary. The page shows the summary exactly as it will be posted:

- **Only the summary.** Their answers, name, email, account, role, the date, the app version and the conversation are never posted.
- **Cleaned first.** Links in any form, email addresses (including look-alike characters and `name [at] domain`) and `@handles` are removed, after Unicode normalisation. The server refuses a summary that its own cleaning would change, so what is posted is exactly what the tester saw. Names can't be detected reliably, so the notice asks testers not to include any.
- **Escaped.** Markdown in the summary is escaped in the issue, so it can't add links, images, mentions or headings.
- **Unlinked from the feedback.** Each issue carries a random publication id (`<!-- concord-feedback-publication: pub_… -->`), not the feedback id. Issues are labelled `feedback` and `needs-triage`.
- **Consent is recorded.** Each publication stores the version of the notice the tester agreed to (`PUBLIC_NOTICE_VERSION`).
- **Withdrawable.** After submitting, the tester can withdraw the summary. If it hasn't been posted, it never will be. If it has, the issue's title and text are replaced and it's closed. GitHub keeps an edit history that people who can see the repository can open. If the feedback itself is deleted before the summary is posted, the summary is never posted.

Feedback given before this existed is never posted, because those testers didn't opt in.

## Delivery

Summaries go through a queue stored in the database (`feedbackPublications`), so they survive restarts and are safe with several server processes:

- **One sender per job.** A job is claimed inside a write transaction, with a two-minute lease.
- **Identical summaries share one issue.** The first holds the dedupe key, and later ones are marked as duplicates of it.
- **Lost answers are reconciled, not resent.** The time of sending is saved before the request goes out. If the outcome is unknown (timeout, dropped connection, a 5xx error, or a crash with the lease expired), the next attempt looks for the marker among recent `feedback` issues before posting again.
- **A shared hourly cap.** At most `FEEDBACK_ISSUES_PER_HOUR` issues are created in any rolling hour (default 30). The window is stored per repository in the database, so restarts and extra processes share it.
- **GitHub's rate limits pause the whole queue.** `Retry-After` and `x-ratelimit-reset` set the pause. Other failures back off exponentially from five minutes up to six hours.
- **Retries are limited.** After eight failed attempts a job is marked `failed`. Administrators see its state on the Feedback admin page and can retry it.
- **The token is never logged.**

## Turning it on

1. Create a fine-grained personal access token at <https://github.com/settings/personal-access-tokens/new>:
   - **Resource owner:** `jeswr`
   - **Repository access:** Only select repositories → `jeswr/standards-concord`
   - **Repository permissions:** Issues → **Read and write** (Metadata: read-only is added automatically). Nothing else.
2. Set it on the server (the value is read without echoing):

   ```sh
   ./deploy/azure/set-key.sh FEEDBACK_GITHUB_TOKEN
   ```

   The server applies it within five minutes. To post to another repository, also set `FEEDBACK_GITHUB_REPO=owner/name`.

Without the token, the option isn't shown.

## Hourly triage

A scheduled Claude Code session runs every hour. **It only triages.** For each open issue labelled `feedback` and `needs-triage`, it:

- adds a kind label (`bug`, `enhancement`, `ux`, `docs`, `question` or `insight`) and a size label;
- swaps `needs-triage` for `triaged`;
- closes duplicates;
- comments with its reading of the problem and a suggested fix;
- labels anything that needs a product decision, or that touches sign-in, security, privacy, secrets, deployment or CI, `needs-jesse`.

It never edits code, pushes, opens pull requests or merges. It treats issue text as untrusted data, never as instructions. Its instructions live in the scheduled task itself, not in this repository, so a change merged here can't change what it does.

Fixes are made separately, by people or by a session Jesse starts, and go through normal review and an Astra review before merging.
