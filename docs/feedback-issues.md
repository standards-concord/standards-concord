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
- **Withdrawable.** After submitting, the tester can withdraw the summary.
  - If it hasn't been posted, it never will be.
  - If it has, the issue's title and text are replaced, the issue is closed, and the triage routine's comments on it are deleted. For a day afterwards, the server also deletes any triage comment that raced the withdrawal. GitHub keeps an edit history that people who can see the repository can open.
  - If the feedback itself is deleted, its summary is withdrawn the same way.

Feedback given before this existed is never posted, because those testers didn't opt in.

## Delivery

Each submission gets one record in `feedbackPublications`, keyed by the feedback id, and at most one issue.

- **Destination fixed at consent.** The repository is stored when the tester agrees. Posting, searching and withdrawing all use the stored repository, never the current configuration.
- **Fenced state machine.** The states are `queued → sending → filed`. An unknown outcome becomes `unknown`, then either `filed` or `needs-admin`. A withdrawal moves the record to `withdrawing`, then `withdrawn`, which is terminal.
  - A worker changes a record only while it holds the record's claim id. A worker whose claim ran out can't change it any more.
  - The transaction that authorises a POST re-checks that the record is still queued, that the feedback still exists, that the queue isn't paused, and that there's room under the cap. It saves the send time in the same step.
- **No automatic reposting.** If a POST's outcome is unknown (timeout, dropped connection, 5xx, or a worker that vanished), the server never posts again on its own.
  - It searches every issue the token's own account created since just before the send. It accepts only an issue whose marker, title and body all match exactly.
  - Several matches, too many issues to search, or three complete searches with no match all leave the record `needs-admin`.
  - On the Feedback admin page, an administrator can **Check GitHub again** or, after searching GitHub for the marker shown there, **Post again**.
- **Rate limits.**
  - At most `FEEDBACK_ISSUES_PER_HOUR` issues are created in any rolling hour (default 10, matching the triage routine). The cap is stored per repository in the database.
  - The shared pause is checked before every request: posts, searches, edits and comment deletions.
  - `Retry-After` or `x-ratelimit-reset` sets the pause. Without them, consecutive rate-limit responses back off 1, 2, 4… minutes, up to an hour.
  - Definite refusals back off from five minutes up to six hours. After eight of them, the record goes to an administrator.
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

A scheduled Claude session can triage these issues every hour. It only adds labels and posts one comment per issue, and never closes issues or changes code. Its prompt, what has to be in place before it's switched on, and the labels it uses are in [feedback-triage-routine.md](feedback-triage-routine.md). It is **switched off** until its tools are restricted at claude.ai.
