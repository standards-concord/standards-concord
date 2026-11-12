---
name: concord-change-governance
description: Propose and follow ontology changes through Concord - report gaps, propose changes, use development forks, edit terms and code lists, and understand classification, review, votes and releases. Use when working with a Concord-hosted ontology or its MCP connector.
---

# Proposing and governing changes through Concord

Concord, from the Open Data Institute, hosts open data standards as strict OWL 2 ontologies and runs every change through the same pipeline: **propose → classify (patch / minor / major) → validate → review under the ontology's governance policy → merge into the working draft → release**. Nothing reaches an ontology without a change request. This skill covers how to take part in that pipeline, as an agent or for a person.

Write terms with the ontology-term-drafting skill and check them with the ontology-checking skill; Concord runs the same checks when you propose.

## Connecting

The MCP server is at `https://standards-concord.vercel.app/mcp` (MCP Registry name `io.github.standards-concord/concord`). It signs in with OAuth on first use, so there is no token to copy.

- Claude Code: `claude mcp add --transport http concord https://standards-concord.vercel.app/mcp`, then `/mcp` → Authenticate.
- Claude (web, desktop, mobile): add a custom connector with that URL, or use *Add to Claude* on the site's `/connect` page.
- Codex: `codex mcp add concord --url https://standards-concord.vercel.app/mcp && codex mcp login concord`.
- Headless agents such as CI use a personal token from *Connect an agent* on the site.

What you can do depends on the signed-in person's role in each ontology (owner, steward, editor, reviewer, contributor, member, ODI). Approving, voting and merging are done by people in the web app, never through the MCP tools.

## The tools

| Tool | Use it to |
|---|---|
| `list_ontologies` | See what exists, with prefix, namespace and version |
| `search_terms`, `get_term` | Find terms by label, synonym, definition or name; read one in full |
| `get_ontology` | Fetch an ontology as Turtle, JSON-LD, RDF/XML, N-Triples, Manchester, LinkML, SHACL, SHACLC, TypeScript or JavaScript (draft by default, or a `version`) |
| `sparql_query` | Read-only SPARQL over the ontology itself (not instance data) |
| `validate_data` | Check instance data against an ontology version |
| `report_gap` | Say something is missing, doesn't fit, is a bug, or is a question; get an immediate answer |
| `propose_change` | Ask for a specific change in plain language; opens a change request |
| `get_change_request` | Status, level, reasons, validation errors and what happens next |
| `create_fork`, `edit_fork`, `get_fork`, `list_forks` | Your own pre-release of an ontology, to use new terms straight away |
| `propose_fork` | Ask the standard to adopt a fork's edits (one change request, updated on re-propose) |
| `check_forks`, `sync_fork`, `discard_fork_changes`, `close_fork` | Keep a fork in step with upstream and move off it once its terms land |

## Start of every development session

If you have forks, call **`check_forks`** first. For each fork it returns one outcome: keep using the fork, sync it, resolve conflicts, switch to the draft or to a release (with the exact import URLs to replace), the fork was closed, or recreate it. Act on it before writing new code against the ontology.

## Choosing a path

Search first (`search_terms`, `get_term`). Then:

| Situation | Path |
|---|---|
| The term exists | Use it. Done. |
| Not sure whether something is missing, or the data doesn't fit | `report_gap` |
| You know exactly what should change | `propose_change` |
| Your code needs the term *now* and can't wait for review | Fork: `create_fork` → `edit_fork` → import the fork URL → `propose_fork` |
| A label, definition, comment, alt label, example or editorial note needs fixing | The *Edit* button on the term in Browse (opens an editorial change request), or `propose_change` |
| A code list or its codes need adding, rewording, moving or deprecating | The ontology's *Code lists* page in Browse, or describe it in `propose_change` |

**Before any call that others will see** (`report_gap`, `propose_change`, `propose_fork`), confirm with the person unless they asked for it: these open requests the working group reviews. Creating and editing a personal fork is fine without asking.

## report_gap

Give `kind` (`missing-concept`, `does-not-fit`, `bug`, `question`), a one-line `summary` (max 200 characters), `details` (what you need and why) and `context` (code, schema or sample data that shows it). The answer is immediate:

- `use-existing-terms`: the ontology already covers it; the answer lists which terms. Use them.
- `local-extension`: define it in your own namespace; it doesn't belong in the standard.
- `change-ontology`: a change request was opened (link returned). Follow it with `get_change_request`.
- `needs-discussion`: the maintainers will pick it up.

## propose_change

Give a short `title` ("Add hours volunteered to volunteering activity") and a `description` that names the terms precisely. Concord drafts structured edits from it; the model never writes RDF directly, the server compiles the edits and validates them. A good description has, for each term: kind, local name, label, definition, superclass or domain and range, any restriction, and why it's needed. Use the term blocks from the ontology-term-drafting skill. Add competency questions with example answers when the change exists to answer them.

Never put people's names, organisations, private use case titles or quotes in a proposal: the ontology and its change history are public. Write "a use case".

## Development forks

A fork is your own pre-release, so app work isn't blocked by review:

1. `create_fork` returns the fork's URL: `https://<site>/def/<ontology>/forks/<fork>` (Turtle by default; `.ttl`, `.jsonld`, `.owl`, `.shacl.ttl`, `.js`, `.ts` and `.tgz` by extension). Import that in the app.
2. `edit_fork` adds or changes terms, in plain language or as structured `terms` (`action` add/update/deprecate, `kind`, `localName`, `label`, `definition`, `superClasses`, `domain`, `range`, `restrictions`, …). Each edit is checked for consistency and is live at the fork URL when it returns.
3. New terms keep the standard's namespace (`vol:VolunteeringActivity`, not a fork-specific IRI), so data written against the fork stays valid after the term lands. Moving off the fork only changes the import URL.
4. `propose_fork` opens one change request with all the fork's edits. Proposing again after more edits updates the same request. Keep using the fork meanwhile.
5. `check_forks` each session. A term counts as landed only when upstream has it *exactly* as the fork does; one reworded or renamed in review doesn't, so you never switch to a version missing what your code uses.
6. `sync_fork` replays outstanding edits on the latest draft. If upstream changed a term the fork also changes, or the result would be inconsistent, nothing changes and the conflicts come back: `discard_fork_changes` for those terms, sync, then redo with `edit_fork` if still needed.
7. When `check_forks` says switch, replace the import URLs it gives (`/def/<ontology>/<version>` or `/draft`; use the `.ttl` form if your code fetches without an Accept header), then `close_fork`. Closed forks keep resolving.

## After proposing: following a change request

`get_change_request` returns `status`, `level`, `reasons`, `validationPassed`, `errors` and `next` (what the policy is waiting for), plus the link. Statuses:

`draft` → `triage` (classifying and validating) → `review` → `voting` (if the policy calls a vote) → `approved` → `merged` (in the working draft) → `released`. Side exits: `needs-work` (validation failed or reviewers asked for changes), `rejected`, `withdrawn`.

- **`needs-work` with errors**: fix the terms (ontology-checking skill) and re-propose: `edit_fork` then `propose_fork` updates the same request; otherwise follow the link and edit it, or open a corrected `propose_change`.
- **Level surprises you**: read the `reasons`. A major classification usually means an additive alternative exists (a new subclass or property instead of narrowing an existing one).
- Don't open duplicates. Check the ontology's *Changes* tab for open requests on the same terms first.

## How governance decides

Each ontology chooses a policy from five templates, then tunes it:

- **Steward-led**: editors fix typos alone, two reviewers sign off new terms, breaking changes go to a members' vote.
- **Lazy consensus**: a change is accepted when its comment period ends with no objection; any objection turns it into a vote.
- **Working group (W3C style)**: editors and reviewers do the detail, a steward confirms consensus, breaking changes need a two-thirds vote with quorum.
- **Membership vote**: every new term and breaking change goes to the members.
- **ODI stewarded**: like steward-led, with ODI oversight that can veto and must approve major changes, releases and ownership transfers.

Within a policy, each level (patch, minor, major) has its own approver roles and counts, review period, optional vote (threshold, quorum, duration), veto roles and whether it merges automatically. Points that catch people out:

- **Rewording a definition** is a patch only if the meaning (the set of things it covers) is kept. Concord asks the proposer, and someone other than the author must confirm it, even where patches need no approval. A change of meaning is reviewed as major; better still, mint a new term and deprecate the old one.
- **An approved request goes back to review** if it grows, newly rewords a definition, or gets a late blocking review or objection before merging. A passed vote isn't reopened.
- **Validation is required** by default: a request that fails the gate can't be approved.
- **App checks**: developers can connect an app whose CI tests it against each open change request; results show on the request, and with autopilot on Concord approves or votes yes for the app's owner when their apps pass.

## Reviewing a change request (for a person)

Look at the Turtle diff tab and the classification. Then check:
- Do the terms follow the drafting rules: reuse checked, naming, one label, genus-differentia definition, placement?
- Is the level right for what it does to existing data? Is there a non-breaking way to get the same result?
- Do the validation report and competency questions pass? Any unexpected inferred subclass relations?
- For a reworded definition: does it really cover exactly the same things?
- Is the evidence enough, and free of private details?

Approve, request changes with a specific fix, or object (which, under lazy consensus, triggers a vote).

## Releases

The working draft becomes a release when someone with release rights publishes it (its own approval rules, often separate from changes'). The release takes the highest level among its merged changes and bumps the semantic version accordingly; nobody picks the number. It is stamped with `owl:versionIRI`, `owl:versionInfo`, `owl:priorVersion` and `owl:backwardCompatibleWith` or `owl:incompatibleWith`, published in every format at `/def/<ontology>/<version>`, and a major release includes a SPARQL migration script. The ontology IRI then serves the latest release.
