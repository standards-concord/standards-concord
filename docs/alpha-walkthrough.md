# Alpha walkthrough

Send testers the `/alpha` link. The walkthrough runs inside the app; this page is the script behind it, for whoever is running the alpha.

The demo ontology is the **volunteering opportunities** standard. It is already at version 1.0.0 and has a simulated working group of six people (all fictional): Priya (ODI, steward), Tom (ontologist), Aisha (council volunteer coordinator), Gareth (CRM developer), Mei (charity research officer) and Daniel (ODI oversight). The governance policy is the W3C-style working group template.

## Versions and returning testers

The top of `/alpha` says which version of Concord the tester is using (and the build commit), with release notes for every version. The versions and their changes live in `packages/shared/src/appReleases.ts`, newest first. Numbers follow semantic-release: each release lists its changes as `feat`, `fix`, `perf` or `breaking`, and the server's unit tests check that the version is the previous one bumped by the biggest change. **When a pull request changes something testers will notice, add a release at the top** with the tester roles it matters to (`steward`, `contributor`, `member`, `odi`, `agent`, or none for everyone), where to try it (`{o}` is the demo ontology) and, ideally, a feedback question (`ask`).

Testers are encouraged to sign in (Google or GitHub, or a tester account kept in their browser when those aren't switched on). Concord then saves each version they test, the roles they tried and their feedback to their own pod (`concord/alpha/testing.jsonld` and `concord/feedback/`). That stays tied to their own account while they play a simulated persona: a second cookie remembers who the tester is until they sign out.

When they come back on a newer version, the page shows what changed since the last version they tested (signed-out testers pick it themselves), the role picker marks roles with changes made for them, the Explore step leads with those changes, and the feedback page offers a short questionnaire about just those changes before the overall questions.

## 1. Pick a role (2 minutes)

Testers enter their name and choose a role. This signs them in to a demo account with a WebID and private storage created automatically.

| Role | What they can do |
| --- | --- |
| Steward | Triage requests, merge approved changes, cut releases, change governance |
| Editor | Draft changes, review, merge approved changes |
| Contributor / domain expert | Describe use cases with the AI interviewer, report bugs, propose changes |
| Voting member | Review and vote |
| Implementer | Connect a coding agent over MCP and report gaps |

## 2. Explore (5 minutes)

- **Overview**: health (consistency, FAIR score), stats and recent activity.
- **Browse**: the class hierarchy and term pages, with definitions and where each term is used.
- **Source**: the ontology as Turtle, LinkML, JSON-LD, RDF/XML, Manchester or SHACL, for the working draft or any release.

## 3. Do something in your role (10 minutes)

Suggested tasks, shown as a checklist in the walkthrough panel:

- **Contributor**: start an interview on *Use cases*. Describe how you'd use volunteering data; the AI asks follow-up questions and builds a use case with competency questions.
- **Everyone**: open *Meetings* and press *Simulate a call*. Watch the transcript arrive line by line and the co-facilitator ask clarifying questions. When it finishes, press *Propose changes* to turn the call into use cases and a draft change request.
- **Editor or member**: open change request *Say whether an opportunity reimburses expenses* (minor). Read the AI triage, the validation report and the classification, then approve it or request changes.
- **Member**: open *Allow only one location per session* (major). Gareth objects because it breaks multi-site data. Add your review; when it goes to a vote, vote.
- **Steward**: open *Releases*, draft a release from the merged changes and see the version number it gets (patch, minor or major), then publish it.
- **Implementer**: open *Agents* (or `/connect`), add Concord to Claude, Claude Code or Codex and sign in when it asks, then ask your agent to build something with the ontology and report anything missing.

## 4. Simulate the others (2 minutes)

The walkthrough panel has two buttons:

- **Let the others act**: the simulated people review, comment and vote on open requests, in character.
- **Fast-forward time**: moves the governance clock on by a few days so review periods end, votes close, approved changes merge and releases are drafted automatically.

This is how the lifecycle runs without meetings: proposal, automatic classification and validation, asynchronous review, a vote only where the policy needs one, merge, release.

## 5. Give feedback (5 minutes)

The *Give feedback* button opens a chat. Testers can type or talk (microphone button; Chrome, Edge and Safari support this natively).

- **Guided**: a short questionnaire covering their role, requirements gathering, governance (which models, how many sign-offs, the ODI's privilege, ownership transfer, automation), formats, and an open "any other comments" question.
- **Open**: say anything; the AI asks a follow-up or two.
- **What's changed** (returning testers only): one question per change since the version they last tested, their role's first, then the overall questions.

Feedback is readable at `/admin/feedback` by ODI staff and ontology owners, with an AI summary of themes and tallies of the governance answers.

## Resetting

An administrator can reset the shared demo (`POST /api/simulation/reset`). Each tester's changes are visible to other testers until then, which is useful when several people try it together.
