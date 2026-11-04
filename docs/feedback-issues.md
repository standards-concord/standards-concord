# Public feedback summaries as GitHub issues

Testers can choose to post a short summary of their feedback as a GitHub issue on this repository. An hourly scheduled Claude session triages those issues (see [Hourly triage](#hourly-triage)).

## What is posted

Nothing is posted by default. Feedback stays on the server, readable only by administrators.

To post anything, a tester ticks **Also post a short public summary as a GitHub issue** on the feedback page and writes a summary. The page shows the summary exactly as it will be posted:

- **Only the summary.** Their answers, name, email, account, role, the date, the app version and the conversation are never posted.
- **Cleaned first.** Links in any form, email addresses (including look-alike characters and `name [at] domain`) and `@handles` are removed, after Unicode normalisation. The server refuses a summary that its own cleaning would change, so what is posted is exactly what the tester saw. Names can't be detected reliably, so the notice asks testers not to include any.
- **Escaped.** Markdown, HTML and character references in the summary are escaped in the issue, so it can't add links, images, mentions or headings.
- **Unlinked from the feedback.** Each issue carries a random publication id (`<!-- concord-feedback-publication: pub_… -->`), not the feedback id. Issues are labelled `feedback` and `needs-triage`.
- **Consent is recorded.** Each publication stores the version of the notice the tester agreed to (`PUBLIC_NOTICE_VERSION`).
- **Withdrawable.** After submitting, the tester can withdraw the summary.
  - If it hasn't been posted, it never will be.
  - If it has, the issue's title and text are replaced, the issue is closed, and the triage comments the server posted on it are deleted by their recorded ids. Nothing else is deleted: other people's comments, and any comment the server didn't post itself, stay. GitHub keeps an edit history that people who can see the repository can open.
  - If the feedback itself is deleted, its summary is withdrawn the same way, whatever state it is in (including waiting for an administrator).

Feedback given before this existed is never posted, because those testers didn't opt in.

## Delivery

Each submission gets one record in `feedbackPublications`, keyed by the feedback id, and at most one issue.

- **Destination fixed at consent.** The repository is stored when the tester agrees. Posting, searching and withdrawing all use the stored repository, never the current configuration.
- **Fenced state machine.** The states are `queued → sending → filed`. An unknown outcome becomes `unknown`, then either `filed` or `needs-admin`. A withdrawal moves the record to `withdrawing`, then `withdrawn`, which is terminal.
  - A worker changes a record only while it holds the record's claim id. A worker whose claim ran out can't change it any more.
  - The transaction that authorises a POST re-checks that the record is still queued, that the feedback still exists, that the queue isn't paused, and that there's room under the cap. It saves the send time in the same step.
- **Nothing is matched on content.** The server only acts on ids it recorded itself: the issue number from GitHub's answer to the POST (or from an administrator), and the id of each comment it posted for the triage routine.
- **No automatic reposting or adopting.** If a POST's outcome is unknown (timeout, dropped connection, 5xx, or a worker that vanished), the server never posts again and never picks an issue on its own.
  - It lists candidates: issues the token's own account created since just before the send that carry the summary's marker or title. They are only shown, never used.
  - The record goes to `needs-admin`. Under **Public summaries waiting for you** on the Feedback admin page, an administrator opens the candidates and chooses **This is it**, types an issue number they found, **Checks GitHub again**, or chooses **None is ours: post again**.
- **Ids are saved as soon as they are known.** A withdrawal saves that it has replaced the issue, and deletes the recorded comment ids one at a time, removing each from the record as it goes (a comment that's already gone counts as deleted). A withdrawal interrupted part-way carries on from what's saved.
- **A withdrawal never succeeds by not finding something.** If a summary may have been posted but its issue number was never recorded, or a triage comment may have been posted without its id being recorded, the withdrawal waits for an administrator. They say which issue it is, or check GitHub by hand and **Confirm nothing is left on GitHub**.
- **Administrators see every record waiting for them**, in its own list, even when the feedback it came from has been deleted: posts and withdrawals needing a decision, triage comments whose outcome is unknown, and summaries taken out of the triage queue.
- **Rate limits.**
  - At most `FEEDBACK_ISSUES_PER_HOUR` issues are created in any rolling hour (default 10, matching the triage routine). The cap is stored per repository in the database.
  - The shared pause is checked before every request: posts, searches, edits and comment deletions.
  - A 429, or a 403 that has `x-ratelimit-remaining: 0`, a `Retry-After` header, or a message about a rate limit (GitHub's secondary limits), counts as a rate limit.
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

A scheduled Claude session can triage these issues every hour. It writes nothing to GitHub itself: it reads its queue from the server and sends its decision back, and the server posts the one comment and applies labels from a fixed list. That way the server records every comment's id (so a withdrawal deletes exactly those), refuses to comment once a summary is withdrawn, and makes a withdrawal wait while a comment is being posted.

| Endpoint | What it does |
| --- | --- |
| `GET /api/feedback/triage/queue` | Up to 10 filed summaries not yet triaged, oldest first (`issue`, `url`, `summary`), and the last 100 triaged ones for spotting duplicates |
| `POST /api/feedback/triage/<issue>` | `{ kind, size, needsJesse?, possibleDuplicateOf?, comment }`. See the rules below. |

The server enforces, for each decision:

- **Which issues.** Only one of the ten oldest filed summaries waiting, whose feedback still exists, and which GitHub says is open and still labelled `feedback` and `needs-triage`. One that GitHub says is closed or unlabelled is taken out of the queue (so it can't hold a place among the ten) and listed for an administrator, who can put it back. At most ten decisions in any rolling hour; refused ones don't count.
- **What it says.** `kind` is one of bug, enhancement, ux, docs, question, insight; `size` is size:small or size:large; `needsJesse` must be true or false, and when true the comment must be exactly “Flagged for the maintainer to review.” `possibleDuplicateOf` must be another, already triaged summary's issue. The comment follows the same rules as testers' summaries (no links, email addresses or @mentions, at most 500 characters) and is posted with all Markdown escaped, followed by the footer.
- **Labels.** It removes any other kind or size label, adds the chosen ones and `triaged`, and removes `needs-triage`. Then it reads the issue's labels again and, if someone changed them meanwhile, restores missing ones and removes conflicting ones once more before reporting success. Other labels are left alone.
- **Exactly one comment, recorded.** The decision is saved before anything is written, and a retry must send the same decision; after a failure part-way, the retry finishes the labels without a second comment. If GitHub's answer to the comment is lost, cut off or has no id, or the worker posting it vanished, the comment is never posted again: the summary leaves the queue and is listed for an administrator, who records the comment's id from the issue (then the retry only finishes the labels) or confirms there is none (then the routine may post it). A withdrawal in the meantime asks an administrator too. A retry of a saved decision doesn't need `needs-triage`, since the first attempt may have removed it.
- **Withdrawals win.** Before every request it checks the summary is still filed, its feedback still exists and the queue isn't paused; a withdrawal waits until a triage in progress stops.

Both need `Authorization: Bearer <FEEDBACK_TRIAGE_TOKEN>`. The token must be at least 32 characters; without it (or with a shorter one) the endpoints answer 404.

**Rotating the token:** generate a new one (`openssl rand -hex 32`), set it on the server with `./deploy/azure/set-key.sh FEEDBACK_TRIAGE_TOKEN`, then replace `CONCORD_TRIAGE_TOKEN` in the routine's environment. The old token stops working as soon as the server picks up the new one (within five minutes); a run in between gets 401 and changes nothing. The routine's prompt and what has to be in place before it's switched on are in [feedback-triage-routine.md](feedback-triage-routine.md). It is **switched off** until then.
