# End-to-end test coverage

Which Playwright spec covers each page, role and flow of Concord, and what is still missing. Every row names the spec file in [`e2e/`](../e2e). Keep it current: a new page, route, role rule or flow gets a row here in the same PR (see [CLAUDE.md](../CLAUDE.md)).

Status: ✅ covered by a test that drives the flow · 🟡 opened or shown, but the interaction isn't exercised · ❌ gap · 🔜 arrives with an open PR that brings its own spec.

Unit and API tests (`pnpm test`, in `apps/server/test` and `apps/web/src/lib`) cover server rules in more depth; this map is only about the browser suite.

## Pages (web app routes)

| Route | What a person does there | Status | Specs |
| --- | --- | --- | --- |
| `/login` | Try the demo; deep link `?next=` returns to the page; signed-in people are sent on; "Alpha tester? Start here" leads to `/welcome`. Sign in with Solid (Solid-OIDC): the button shows the Solid logo and opens the suite's shared sign-in card in a dialog (providers in order, WebID, other provider's address, Get a pod), each choice goes to `/auth/solid` with the return path, the card shows it's signing in and can be cancelled, closing the dialog while waiting calls the trip off (and the card is fresh next time), a refused WebID reopens it with the reason on the WebID field and a refused provider or address above the card, keyboard and Escape, axe, follows the look without restyling Concord, hidden when signed in or switched off; against a real Community Solid Server, sign in by WebID or by the provider's address as "Other provider", and signing in again finds the same account | ✅ | app, account, welcome, sign-in-with-solid; solid-signin (`pnpm test:e2e:solid`, CI job `e2e-solid`) |
| `/welcome` | Alpha landing page: what Concord is for, both walkthrough videos with captions and transcripts (or a notice before any release has them), the four alpha steps, links into `/alpha` and `/feedback`; no floating walkthrough panel; fits a phone; works signed out. `/api/media/` serves only the six video files, never a symlink | ✅ | welcome, account |
| `/alpha` | Guided walkthrough: welcome, pick a role, tasks per role, simulate the others, feedback; floating panel | ✅ | alpha |
| `/feedback` | Open and guided pathways, captured answers, voice, submit, start again; works signed out. Opt-in public summary posted as a GitHub issue exactly as previewed, then withdrawn. Who can read your feedback (the admins, their WebIDs, Anthropic when Claude runs the interview, OpenAI when the server transcribes); a signed-in tester's copy lands in their pod, shared read-only with the admin WebIDs and closed to everyone else | ✅ | feedback, feedback-issues (against a GitHub stand-in), webid-signin; solid-signin |
| `/privacy` | Read the privacy policy signed out or in; reached from the sign-in card and the footer; deletion contact is a mail link | ✅ | privacy |
| `/connect` | Pick an app (arrow keys), install links and commands, copy buttons; signed in: connected agents (disconnect) and personal tokens (create, save, revoke); signed out: sign in and come back ; every app shows its own logo, same size, visible in light and dark mode | ✅ | connect, agents, oauth |
| `/appearance` | Pick a visual style; works signed out | ✅ | looks |
| `/oauth/authorize` | Consent: sign in, allow, decline; refuses script and plain-http redirects, background approval, stale links | ✅ | oauth |
| `/` (hub) | List ontologies, open one, activity feed links, create an ontology | ✅ | account, governance-flow, public-page |
| `/settings` (Profile) | Profile, ways to sign in, WebID and pod folded away; old `#agents`, `#tokens`, `#appearance` links redirect to /connect and /appearance | ✅ | account, app, connect |
| `/admin/feedback` | Read and summarise tester feedback (platform admins only); an admin signed in with their WebID reads testers' feedback straight from their pods as that WebID (per browser session; ends on sign-out) | 🟡 | security (refusal for non-admins); solid-signin (the pod reader, with a real Community Solid Server, and a non-admin WebID refused). Reading it needs an admin email sign-in, which demo mode can't do: covered by the API tests, including the list of public summaries waiting for a decision and its actions (pick the issue, check again, post again, confirm a withdrawal) in `apps/server/test/feedbackIssues.test.ts`. The triage routine's endpoints are API-only and covered there too |
| `/o/:id` overview | Lifecycle bubble, health chip, lint, reasoner (and its in-browser re-check), FAIR and competency questions, members, policy link, recent activity; `#health` focus while loading; popups on very short screens | ✅ | ia, disclosure, alignment, reasoner, roles |
| `/o/:id/browse` | Tree, open a term, deep link, search, report a problem with a term | ✅ | browse-basics; 🔜 #9 (class diagram, accessible tree), #28 (inline term editing) |
| `/o/:id/source` | Every serialisation, highlighted; search, folding, copy, download; a release's source | ✅ | formats; 🔜 #18 (SHACL compact syntax, JS classes) |
| `/o/:id/query` | Chat-to-query assistant (writes and refines, runs only on a click, offline helper declines what it can't express), SPARQL editor, examples, every query form, sample data and SHACL check, pagination, per-account drafts (cleared on sign-out in any tab), background runs with Cancel, time limit, memory cap and result budgets, LIMIT banner | ✅ | query |
| `/o/:id/validate` | Paste or upload data, pick the version, read the report (shapes and terms, cut short at 1,000), download JSON and Turtle reports, see how to call the API | ✅ | validate |
| `/o/:id/query?view=check` | Check data: problems as sentences in the data's own prefixes, underlined in the editor with hover popups, click to jump; live syntax and misspelt-term underlines; Format; any member can check, signed out goes to sign in | ✅ | check-data, query |
| `/o/:id/connect` | Connect an agent to this ontology | ✅ | connect |
| `/o/:id/use-cases` | List, describe a use case (starts an interview), draft changes from a selection | ✅ | requirements, ia; 🔜 #15 (sharing modes, anonymised versions) |
| `/o/:id/use-cases/:id` | Read the document, continue, mark ready, draft changes, archive | ✅ | requirements, ia |
| `/o/:id/interview/:id` | Chat (typed, Enter/Shift+Enter, spoken), progress, layouts, finish | ✅ | requirements, ia |
| `/o/:id/meetings` | Upload or paste a transcript, choose a file, invite the bot, run a simulated call | ✅ | meeting-transcripts; 🔜 #11 (invite by email, prompts in Meet chat) |
| `/o/:id/meetings/:id` | Transcript, live stream, bot prompts, analysis, turn into use cases and a change request | ✅ | meeting-transcripts |
| `/o/:id/changes` | Filter by scope and status, new change request, report a bug, reports from the public page (editors and up) | ✅ | change-requests, ia, public-page |
| `/o/:id/changes/:id` | Changes/Checks/Discussion tabs, triples view, approve, request changes, object, comment, vote, merge, revise with AI, resubmit, withdraw | ✅ | change-requests, governance-flow, ia, disclosure, app-checks (Checks tab results, autopilot's say in Discussion) |
| `/o/:id/releases` | Grouped list, draft a release | ✅ | governance-flow, ia |
| `/o/:id/releases/:id` | Notes, included changes, publish; live approval while open; read-only approval record once published or rejected, labelled recorded or checked against today’s policy | ✅ | governance-flow, ia, public-page, release-history, roles |
| `/o/:id/apps` | Connect an app (name, repo), copy its token and workflow, turn on autopilot, refresh results, disconnect (owners and stewards); empty state; phone layout | ✅ | app-checks |
| `/o/:id/governance` | Summary, edit and save the policy (owners only), templates, members and roles, transfer ownership, the autopilot switch | ✅ | governance-flow, ia, roles, app-checks |
| `/o/:id/agents` | Agent reports, analysis collapsed | ✅ | agents, connect |
| `*` | Not found | ✅ | app |

## Served by the API server (not the web app)

| Route | Status | Specs |
| --- | --- | --- |
| Public ontology page at the ontology IRI (`/def/...`), version IRIs, term fragments, use cases tab, downloads, content negotiation, no-JS, phone | ✅ | public-page, live, validate (POST validation at the IRI, SHACL profile) |
| Publishing only approved content: a change drafted from use cases approved byte for byte (`/o/:id/changes/:cr`), versions published before approvals held until a steward approves them (Governance), held content kept out of every signed-out read and summary | ✅ | privacy-review (screens; held versions stubbed, since this server's API can't make a pre-approval ontology), plus `apps/server/test/public.test.ts` for the server side and `apps/server/test/validate.test.ts` for POST validation at a held version |
| `/mcp` with OAuth (discovery, registration, consent, tools) | ✅ | oauth |
| `/mcp` with a personal token: every tool, refusal without a token, revoked token | ✅ | agents |
| WebID profile (`/people/:id`) | ✅ | account |
| Google and GitHub sign-in callbacks | 🟡 | security (refuses a missing state). The full round trip needs real OAuth apps: not testable offline |
| Daily and monthly spending limit on Claude calls (falls back to the offline stand-in when reached; concurrent calls can't overshoot; failed calls refunded; survives the demo clock and demo resets) | 🟡 | Not reachable from the browser: the suite runs with the offline LLM only, and a model can't be switched on per spec. Covered by `apps/server/test/llmBudget.test.ts` against a stand-in Messages API |

## Roles

Each flow is tested as someone allowed to do it and, where the UI hides or refuses it, as someone who isn't.

| Role | Allowed (tested) | Refused or hidden (tested) | Specs |
| --- | --- | --- | --- |
| Signed out | Login, welcome page, walkthrough, feedback, connect, public pages | Every `/o/...` page and settings redirect to login; MCP without a token is 401 | app, account, agents, public-page |
| Contributor (Aisha) | Describe use cases, comment, approve (doesn't count), check data | Submit or withdraw someone else's request; edit the policy; manage members | change-requests, requirements, governance-flow |
| Editor (Tom) | Draft, submit, revise, withdraw own requests | Own approval doesn't count; drafting a release is 403 | change-requests, governance-flow |
| Reviewer (Mei, Gareth) | Approve, report bugs, report problems with terms | | change-requests, browse-basics |
| Steward / owner (Priya, or a new creator) | Create ontology, edit and save the policy, add and remove members, change roles, merge, draft and publish releases, transfer ownership | | governance-flow, change-requests |
| Voting member (Gareth, once given the role) | Vote, change a vote | Contributors can't vote | governance-flow |
| Steward without ownership | Sees Governance and Manage members | Edit policy hidden; policy PUT is 403 | roles |
| ODI (Daniel) | Sees Governance in the nav | | ❌ no flow yet exercises ODI veto or final say through the UI (policy summary only, in ia); nav in roles |
| Every demo tester role | Account button shows the role in brackets; nav shows that role's sections, with "Show all sections" for the rest | Governance hidden from the nav (not locked) for roles other than owner, steward and ODI | roles |
| Platform admin | | Non-admins can't read feedback, and the menu hides it | security |
| Agent (token or OAuth) | Every MCP tool | Revoked or missing token | agents, oauth |

## Governance flows

| Flow | Status | Specs |
| --- | --- | --- |
| Plain-language request → drafted edits → submit → classified and validated | ✅ | change-requests |
| OWL 2 DL reasoning with sparq: working-draft health (the health popover for no verdict, consistency only, unsatisfiable classes and inconsistency), a change that makes a class unsatisfiable, rerunning the check in the browser (in a Web Worker, compared only at the same revision), signed-out visitors refused | ✅ | reasoner |
| Approvals from the right roles; author's own doesn't count; review period; auto-merge | ✅ | change-requests |
| Request changes → needs work → AI revision → back in review (earlier approvals reset) | ✅ | change-requests |
| Comments show once in the discussion | ✅ | change-requests |
| Auto-merge off → approved → manual merge | ✅ | governance-flow |
| Withdraw | ✅ | change-requests |
| Bug report (from Changes and from a term) | ✅ | change-requests, browse-basics |
| Report a problem from the public page (anonymously, or by signing in as a member), held for editors to open as a bug report or dismiss | ✅ | public-page; server side (tokens, limits, claims, versions) in `apps/server/test/report.test.ts` |
| Changes from agents (`propose_change`, `report_gap`) | ✅ | agents |
| Changes from use cases and meetings | ✅ | requirements, meeting-transcripts |
| Draft release → publish → current version, change requests released | ✅ | governance-flow |
| A policy that asks for a vote: review, then members vote, change a vote, non-voters refused | ✅ | governance-flow |
| Votes on a release | ❌ | Needs a release level whose rule votes; same pattern as the change vote |
| An objection from a veto role rejects the change | ✅ | governance-flow |
| Lazy consensus and ODI final say outcomes | ❌ | Policy text is checked (ia); outcomes are covered by API tests only |
| Resubmit after "request changes" starts a new review round: earlier approvals and requests for changes stop counting (objections stand), reviewers are asked again; reviewers can approve from Needs work | ✅ | change-requests (API: `review-rounds.test.ts`, `governance.test.ts`) |
| A veto, a request for changes or a lost approval after approval stops the merge; decisions wait while a merge is under way | ✅ | API only: `review-rounds.test.ts` (the race needs a paused merge, which a browser can't arrange) |
| Decisions name the round they were made on; one made on an older version is refused | ✅ | API: `review-rounds.test.ts` (the page always sends the round on screen) |
| Authors can't request changes to or object to their own edits | ✅ | API: `review-rounds.test.ts` |
| A vote against stands when the edits change (the voter is told, and can change it); votes for are asked again | ✅ | governance-flow (API: `review-rounds.test.ts`, `governance.test.ts`) |
| Ownership transfer (owner decides) | ✅ | governance-flow |
| Ownership transfer by member vote or ODI approval | ❌ | |
| Simulated participants and clock | ✅ | alpha, ia, account |
| Reset the simulation | ❌ | Deliberately untested in the shared run: it wipes every other spec's data |

## Open pull requests that bring their own specs

| PR | Adds | Spec |
| --- | --- | --- |
| #9 | Class diagram, better graph, accessible tree, richer class pages | browse.spec.ts |
| #11 | Meet bot by invite email, prompts in Meet chat; calls still getting rid of a bot, and letting go of a booking Recall.ai never confirmed (stood-in server answers: no Recall.ai key in e2e; the bot state machine is in apps/server/test/meetBot.test.ts) | meetings.spec.ts |
| #15 | Use case sharing modes, anonymised versions, per-release requirements | use-cases.spec.ts |
| #18 | SHACL compact syntax and JavaScript classes at the ontology URI | classes.spec.ts |
| #19 | Development forks | forks.spec.ts |
| #28 | Inline term editing in Browse | term-edit.spec.ts |
| #34 | OAuth client-auth downgrade refusal, unverified app label | oauth.spec.ts, connect.spec.ts |
| #35 | Privacy redaction in everything published | public-page.spec.ts |
| #37 | One place for agents, Appearance page, role-based views | roles.spec.ts |
| #38 | Chat-to-query beside the SPARQL editor | query.spec.ts |
| #39 | App versions, tester record in the pod, what's changed | tester-versions.spec.ts |
| #51 | OWL 2 DL reasoning with sparq (no HermiT), in-browser re-check | reasoner.spec.ts |
| #52 | Concord's logo (climbing two-halves plane) in every look's masthead, after the ODI logo in the ODI look; the plain plane as the tab icon | looks.spec.ts |

## Known gaps, in priority order

1. ODI veto and final say, and lazy consensus, through the UI.
2. Release votes, and ownership transfer by member vote.
3. Admin feedback page with a real admin session (needs a test-only way to sign in as an admin).
4. Google and GitHub sign-in round trips (need real OAuth apps; covered on the live site by hand).
5. Resetting the simulation (wipes the shared data, so it needs its own server).

## Bugs this audit found

Each fix has a test that fails without it.

| Bug | Fix | Test |
| --- | --- | --- |
| Modal dialogs had no accessible name, so screen readers announced just "dialog" | Dialogs are labelled by their title | every `getByRole('dialog', { name })` in change-requests, governance-flow, meeting-transcripts, browse-basics |
| A reviewer's comment showed twice in the Discussion tab | Timeline copies of comments are skipped | change-requests: "a contributor can comment…" |
| Policy switches (auto-merge, vote, lazy consensus) and the new-owner picker had no names | Named per level, e.g. "Auto-merge (minor)" | governance-flow |
| Role and filter chips only showed "on" with colour and a tick | Chips expose `aria-pressed` | governance-flow |
| Typing in a dialog jumped back to its first field whenever the page behind it re-rendered (e.g. a list finishing loading), so a change description landed in Title | Dialog focuses its first field only when it opens | change-requests: "typing in a dialog stays in the field…" |
| A comment typed while a review or vote was being saved was wiped when the response came back | Only the comment that was sent is cleared | change-requests: "a comment typed while an approval is being saved…" |
| The chat box was named by its placeholder, so its name changed to "Listening…" while dictating | Stable `aria-label` | requirements: "answers can be spoken" |
| Feedback answer fields had no names | Named after their question | feedback: "guided feedback…" |
| With the async store, two requests at once could interleave a check and its write: two ownership transfers left two owners, change requests shared a number, a release was drafted twice, and edits to different use-case sections overwrote each other | Each check and its writes run in one transaction | API tests, `apps/server/test/concurrency.test.ts`: the browser can't send two requests in the same tick, and on SQLite the race doesn't show over HTTP |
| Converting the code merged from main to the async store: an async check inside `filter()`/`flatMap()` counted every promise as a yes, so contributors saw activity about calls waiting for approval, the meetings list came back as empty objects, withdrawn feedback stayed in the triage queue, and the administrator's pod view read demo accounts' pods; tester-record visits arriving at once overwrote each other; a release's last-moment draft check ran too late to stop the write | Loops or `Promise.all` before filtering; visits saved in one transaction; the release check is synchronous and its type refuses an async one | API tests: `meetBot.test.ts` (activity), `api.test.ts` "lists the calls a signed-in person can see", `feedbackIssues.test.ts` "leaves out summaries that are withdrawn…", `solidOidc.test.ts` "leaves out the pods of demo accounts", `alpha.test.ts` "keeps every update…", `releaseWrite.test.ts`; the browser suite covers the meetings list too |
| Review r9: a publish that failed after writing a release's files took back its public hold, so the half-written version went public unapproved; two sign-ins at once could attach one GitHub or Google identity to two demo accounts, or give a second identity racing to link the same demo account a new account, into which the demo account's testing record was then moved, closing it for the first; an existing account signing in from that browser just after could do the same, an identity could be attached to a demo account whose record had already moved, and a refused sign-in could still update the existing account | The hold is taken back only if nothing was written, no other publish still relies on it and the version has no files; the identity lookup and attachment run in one transaction, and a second identity linking a demo account that was just linked is refused (409), whether it is new or already has an account, moving a record re-checks that its account is still a demo one, a demo account whose record moved takes only a retry by the identity it moved to, and the checks, attachment and move commit in one transaction | API tests: `public.test.ts` "keeps a release held when publishing fails…" and "takes a hold back only when…", `concurrency.test.ts` "attaches an identity to one account, and refuses a second…" and "leaves alone a demo account another identity has just attached to…", "refuses to attach an identity to a demo account whose record has already moved…", "changes nothing on an existing account whose sign-in is refused…" |
| The AI spending limit could be passed: the SDK retried failed calls behind one reservation, and dense scripts were reserved for too few tokens | No automatic retries; prompts bounded at a token per byte, schema included | API tests, `apps/server/test/llmBudget.test.ts` (the browser suite has no model to call) |
| Section tabs could open the wrong page after a quick click (stale remembered page; the ia.spec flake) | The target is looked up at click time | ia: "each section remembers the page you were last on" |
| Resubmit did nothing after "request changes" (the old review sent it straight back to Needs work) | Resubmitting starts a new review round, like GitHub dismissing stale reviews; reviewers can approve from Needs work | change-requests: "resubmitting starts a new review round…"; review-rounds.test.ts, governance.test.ts |
| An approved request stayed approved, and could be merged, after an owner's veto or after its only approver switched to an objection; a veto during a merge was overtaken by it | Approval needs governance to still say "approved" (unless a vote passed); merges go through #28's lock and revision check | review-rounds.test.ts |
| Rewriting a request's edits, even to the same effect, erased every vote, so an author could clear the "no" votes; comparing edits by their effect then lost real edits (order-sensitive lists, a `source`), and stalled the server on large lists | Any change to the edits is saved and starts a new round, but a vote against stands until the voter changes it; the same edits again keep reviews and votes | governance-flow: "a vote against stands when the edits change…"; review-rounds.test.ts, governance.test.ts |
| Lazy consensus read a "no" vote standing from earlier edits as silence, so a change could auto-merge with no support ("No objections were raised") | A standing vote against counts as opposition, like an objection: the change goes to a vote | review-rounds.test.ts, governance.test.ts (API only: getting there needs edits changed during a vote, which the page doesn't offer) |
| Simulated voters whose "no" was on earlier edits were never asked about the new ones | Simulated voters are asked once per version of the edits | review-rounds.test.ts |
| A merge that failed on the latest draft said earlier approvals no longer counted, but they still did | A failed merge starts a new round | review-rounds.test.ts |
| Simulated reviewers posted the same comment twice in one round | Anyone who has said anything this round isn't asked again | review-rounds.test.ts |
| A decision made on a page showing an older version landed in the new round | Decisions carry the round they were made on, and a mismatch is a 409 | review-rounds.test.ts |
| New edits made during review inherited the old review period | A real edit starts its own review period | review-rounds.test.ts |
| An author could request changes on their own request and resubmit, to reset everyone's reviews | Writers can't request changes or object to their own edits | review-rounds.test.ts |
| With the clock moved back, an earlier approval hid a later veto | Decisions are ordered by a per-request sequence number, not the clock | governance.test.ts |
| Buttons nested in links (header Sign in and Give feedback, Hub, Walkthrough, Login, Profile, Feedback, OAuth consent, Not found, Releases, Source download): two tab stops for one action, invalid HTML | Links styled as buttons are single links (LinkButton, AnchorButton, buttonClasses) | markup: "no nested interactive elements" |
| Check data problems showed full `<https://…>` IRIs: sparq wraps IRIs in angle brackets, which the prefix lookup never matched, and only the ontology's prefixes were tried | Problems are written with the data's own prefixes first | check-data: "problems use the prefixes the data declares" |
| Check data: an out-of-range `\U` escape threw while rendering and crashed the page | Invalid escapes are positioned syntax errors | check-data: "an invalid character escape is a syntax error, not a crash" |
| Check data: after an edit, an old report's underline moved onto the record's name | Out-of-date reports underline nothing and can't be jumped to until checked again | check-data: "problems read as sentences…" |
| Check data: fixing a value in place left its old underline on the new text until typing paused | An edit drops the underlines it touches at once; the rest move with the text | check-data: "an edit clears the underline it touches at once, and leaves the others" |
| Check data: problems about anonymous `[ … ]` records said "Not in your data", as if they weren't real | They say "Location unavailable" and why; written `_:labels` and a record's only anonymous value are pointed to | check-data: "a problem with no place in the text says why"; unit: shaclFindings "finds _:labels…", "explains why…" |
| Check data: "Show all" rendered every problem at once (10,000 rows froze the page) and stayed expanded | Long problem lists are paged, 50 at a time | check-data: "a long list of problems is shown a page at a time" |
| Check data: node-level results (no path, the record as its own value) lost their underline and jump; a written `_:__ttl_anon_…` label was treated as anonymous; "has more than one" with a single value; an `sh:or` member with two kinds of requirement was described by one | Located, located, accurate wording, general wording | unit: shaclFindings "a node-level finding points at the record", "a written _:label is found…", "only says there are several…", "an alternative with two kinds…" (needs custom shapes the demo ontology doesn't have) |
| Check data: after Next, focus stayed on the button and nothing said what changed; an edited live list reopened on an old page | Focus moves to the new page, whose label carries "51–100 of N"; a list of a different length starts at page 1 | check-data: "a long list of problems is shown a page at a time", "a changed list of Turtle problems starts again at the first page" |
| Check data: a node-level result for a record only used as a value (`sh:targetObjectsOf`) couldn't be located | It points to where the record is used | unit: shaclFindings "a node-level finding for a record only used as a value…" |
| Check data: 4,000 nested `[ … ]` overflowed the stack and crashed the page | Nesting deeper than 200 is a positioned error | unit: shaclFindings "deeply nested brackets are a positioned error, not a crash" |
| Browse tree leaves expose disabled, unnamed Collapse/Expand buttons | Routed to PR #9, which replaces the tree | |
