# End-to-end test coverage

Which Playwright spec covers each page, role and flow of Concord, and what is still missing. Every row names the spec file in [`e2e/`](../e2e). Keep it current: a new page, route, role rule or flow gets a row here in the same PR (see [CLAUDE.md](../CLAUDE.md)).

Status: ✅ covered by a test that drives the flow · 🟡 opened or shown, but the interaction isn't exercised · ❌ gap · 🔜 arrives with an open PR that brings its own spec.

Unit and API tests (`pnpm test`, in `apps/server/test` and `apps/web/src/lib`) cover server rules in more depth; this map is only about the browser suite.

## Pages (web app routes)

| Route | What a person does there | Status | Specs |
| --- | --- | --- | --- |
| `/login` | Try the demo; deep link `?next=` returns to the page; signed-in people are sent on; walkthrough link | ✅ | app, account |
| `/alpha` | Guided walkthrough: welcome, pick a role, tasks per role, simulate the others, feedback; floating panel | ✅ | alpha |
| `/feedback` | Open and guided pathways, captured answers, voice, submit, start again; works signed out | ✅ | feedback |
| `/connect` | Pick an app, install links and commands, copy buttons | ✅ | connect |
| `/oauth/authorize` | Consent: sign in, allow, decline; refuses script and plain-http redirects, background approval, stale links | ✅ | oauth |
| `/` (hub) | List ontologies, open one, activity feed links, create an ontology | ✅ | account, governance-flow, public-page |
| `/settings` | Profile and WebID, pod, sign-in providers, connected agents (disconnect), personal tokens (create, revoke), appearance | ✅ | account, agents, oauth, looks |
| `/admin/feedback` | Read and summarise tester feedback (platform admins only) | 🟡 | security (refusal for non-admins). Reading it needs an admin email sign-in, which demo mode can't do: covered by the API tests |
| `/o/:id` overview | Lifecycle bubble, health chip, lint, FAIR and competency questions, members, recent activity | ✅ | ia, disclosure, alignment |
| `/o/:id/browse` | Tree, open a term, deep link, search, report a problem with a term | ✅ | browse-basics; 🔜 #9 (class diagram, accessible tree), #28 (inline term editing) |
| `/o/:id/source` | Every serialisation, highlighted; search, folding, copy, download; a release's source | ✅ | formats; 🔜 #18 (SHACL compact syntax, JS classes) |
| `/o/:id/query` | Visual builder, SPARQL editor, examples, every query form, sample data and SHACL check, pagination, drafts | ✅ | query; 🔜 #38 (chat-to-query replaces the builder) |
| `/o/:id/query?view=check` | Check data: problems as sentences in the data's own prefixes, underlined in the editor with hover popups, click to jump; live syntax and misspelt-term underlines; Format; any member can check, signed out goes to sign in | ✅ | check-data, query |
| `/o/:id/connect` | Connect an agent to this ontology | ✅ | connect |
| `/o/:id/use-cases` | List, describe a use case (starts an interview), draft changes from a selection | ✅ | requirements, ia; 🔜 #15 (sharing modes, anonymised versions) |
| `/o/:id/use-cases/:id` | Read the document, continue, mark ready, draft changes, archive | ✅ | requirements, ia |
| `/o/:id/interview/:id` | Chat (typed, Enter/Shift+Enter, spoken), progress, layouts, finish | ✅ | requirements, ia |
| `/o/:id/meetings` | Upload or paste a transcript, choose a file, invite the bot, run a simulated call | ✅ | meeting-transcripts; 🔜 #11 (invite by email, prompts in Meet chat) |
| `/o/:id/meetings/:id` | Transcript, live stream, bot prompts, analysis, turn into use cases and a change request | ✅ | meeting-transcripts |
| `/o/:id/changes` | Filter by scope and status, new change request, report a bug | ✅ | change-requests, ia |
| `/o/:id/changes/:id` | Changes/Checks/Discussion tabs, triples view, approve, request changes, object, comment, vote, merge, revise with AI, resubmit, withdraw | ✅ | change-requests, governance-flow, ia, disclosure; 🔜 #17 (app checks, autopilot) |
| `/o/:id/releases` | Grouped list, draft a release | ✅ | governance-flow, ia |
| `/o/:id/releases/:id` | Notes, included changes, publish; approval details | ✅ | governance-flow, ia, public-page |
| `/o/:id/governance` | Summary, edit and save the policy, templates, members and roles, transfer ownership | ✅ | governance-flow, ia |
| `/o/:id/agents` | Agent reports, analysis collapsed | ✅ | agents, connect |
| `*` | Not found | ✅ | app |

## Served by the API server (not the web app)

| Route | Status | Specs |
| --- | --- | --- |
| Public ontology page at the ontology IRI (`/def/...`), version IRIs, term fragments, use cases tab, downloads, content negotiation, no-JS, phone | ✅ | public-page, live; 🔜 #32 (POST validation at the IRI), #35 (privacy redaction) |
| `/mcp` with OAuth (discovery, registration, consent, tools) | ✅ | oauth |
| `/mcp` with a personal token: every tool, refusal without a token, revoked token | ✅ | agents |
| WebID profile (`/people/:id`) | ✅ | account |
| Google and GitHub sign-in callbacks | 🟡 | security (refuses a missing state). The full round trip needs real OAuth apps: not testable offline |

## Roles

Each flow is tested as someone allowed to do it and, where the UI hides or refuses it, as someone who isn't.

| Role | Allowed (tested) | Refused or hidden (tested) | Specs |
| --- | --- | --- | --- |
| Signed out | Login, walkthrough, feedback, connect, public pages | Every `/o/...` page and settings redirect to login; MCP without a token is 401 | app, account, agents, public-page |
| Contributor (Aisha) | Describe use cases, comment, approve (doesn't count), check data | Submit or withdraw someone else's request; edit the policy; manage members | change-requests, requirements, governance-flow |
| Editor (Tom) | Draft, submit, revise, withdraw own requests | Own approval doesn't count; drafting a release is 403 | change-requests, governance-flow |
| Reviewer (Mei, Gareth) | Approve, report bugs, report problems with terms | | change-requests, browse-basics |
| Steward / owner (Priya, or a new creator) | Create ontology, edit and save the policy, add and remove members, change roles, merge, draft and publish releases, transfer ownership | | governance-flow, change-requests |
| Voting member (Gareth, once given the role) | Vote, change a vote | Contributors can't vote | governance-flow |
| ODI (Daniel) | | | ❌ no flow yet exercises ODI veto or final say through the UI (policy summary only, in ia) |
| Platform admin | | Non-admins can't read feedback, and the menu hides it | security |
| Agent (token or OAuth) | Every MCP tool | Revoked or missing token | agents, oauth |

## Governance flows

| Flow | Status | Specs |
| --- | --- | --- |
| Plain-language request → drafted edits → submit → classified and validated | ✅ | change-requests |
| Approvals from the right roles; author's own doesn't count; review period; auto-merge | ✅ | change-requests |
| Request changes → needs work → AI revision → back in review (earlier approvals reset) | ✅ | change-requests |
| Comments show once in the discussion | ✅ | change-requests |
| Auto-merge off → approved → manual merge | ✅ | governance-flow |
| Withdraw | ✅ | change-requests |
| Bug report (from Changes and from a term) | ✅ | change-requests, browse-basics |
| Changes from agents (`propose_change`, `report_gap`) | ✅ | agents |
| Changes from use cases and meetings | ✅ | requirements, meeting-transcripts |
| Draft release → publish → current version, change requests released | ✅ | governance-flow |
| A policy that asks for a vote: review, then members vote, change a vote, non-voters refused | ✅ | governance-flow |
| Votes on a release | ❌ | Needs a release level whose rule votes; same pattern as the change vote |
| An objection from a veto role rejects the change | ✅ | governance-flow |
| Lazy consensus and ODI final say outcomes | ❌ | Policy text is checked (ia); outcomes are covered by API tests only |
| Resubmit after "request changes" | 🔜 | The next PR fixes Resubmit (it used to bounce straight back to Needs work) and adds the regression test |
| Ownership transfer (owner decides) | ✅ | governance-flow |
| Ownership transfer by member vote or ODI approval | ❌ | |
| Simulated participants and clock | ✅ | alpha, ia, account |
| Reset the simulation | ❌ | Deliberately untested in the shared run: it wipes every other spec's data |

## Open pull requests that bring their own specs

| PR | Adds | Spec |
| --- | --- | --- |
| #9 | Class diagram, better graph, accessible tree, richer class pages | browse.spec.ts |
| #11 | Meet bot by invite email, prompts in Meet chat | meetings.spec.ts |
| #15 | Use case sharing modes, anonymised versions, per-release requirements | use-cases.spec.ts |
| #17 | App checks against proposed changes, autopilot votes | app-checks.spec.ts |
| #18 | SHACL compact syntax and JavaScript classes at the ontology URI | classes.spec.ts |
| #19 | Development forks | forks.spec.ts |
| #28 | Inline term editing in Browse | term-edit.spec.ts |
| #32 | Data validator page, POST validation at the ontology IRI | validate.spec.ts |
| #34 | OAuth client-auth downgrade refusal, unverified app label | oauth.spec.ts, connect.spec.ts |
| #35 | Privacy redaction in everything published | public-page.spec.ts |
| #37 | One place for agents, Appearance page, role-based views | roles.spec.ts |
| #38 | Chat-to-query beside the SPARQL editor | query.spec.ts |
| #39 | App versions, tester record in the pod, what's changed | tester-versions.spec.ts |

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
| The chat box was named by its placeholder, so its name changed to "Listening…" while dictating | Stable `aria-label` | requirements: "answers can be spoken" |
| Feedback answer fields had no names | Named after their question | feedback: "guided feedback…" |
| Section tabs could open the wrong page after a quick click (stale remembered page; the ia.spec flake) | The target is looked up at click time | ia: "each section remembers the page you were last on" |
| Resubmit did nothing after "request changes" | Next PR: earlier requests for changes become stale on resubmit; reviewers can approve from Needs work | Next PR (change-requests) |
| Buttons nested in links (Hub, Shell, Feedback, Walkthrough, OAuth consent, Overview) | Routed to the IA thread, after #37 | |
| Check data problems showed full `<https://…>` IRIs: sparq wraps IRIs in angle brackets, which the prefix lookup never matched, and only the ontology's prefixes were tried | Problems are written with the data's own prefixes first | check-data: "problems use the prefixes the data declares" |
| Check data: an out-of-range `\U` escape threw while rendering and crashed the page | Invalid escapes are positioned syntax errors | check-data: "an invalid character escape is a syntax error, not a crash" |
| Check data: after an edit, an old report's underline moved onto the record's name | Out-of-date reports underline nothing and can't be jumped to until checked again | check-data: "problems read as sentences…" |
| Check data: fixing a value in place left its old underline on the new text until typing paused | An edit drops the underlines it touches at once; the rest move with the text | check-data: "an edit clears the underline it touches at once, and leaves the others" |
| Check data: problems about anonymous `[ … ]` records said "Not in your data", as if they weren't real | They say "Location unavailable" and why; written `_:labels` and a record's only anonymous value are pointed to | check-data: "a problem with no place in the text says why"; unit: shaclFindings "finds _:labels…", "explains why…" |
| Check data: 4,000 nested `[ … ]` overflowed the stack and crashed the page | Nesting deeper than 200 is a positioned error | unit: shaclFindings "deeply nested brackets are a positioned error, not a crash" |
| Browse tree leaves expose disabled, unnamed Collapse/Expand buttons | Routed to PR #9, which replaces the tree | |
