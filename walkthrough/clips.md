---
title: Concord, one feature at a time
---

<!--
  Short clips, one feature each, for the features the tour and the closer look don't
  show. The /welcome page lists them in a drop-down playlist.

  Each scene (##) is recorded as its own file, concord-clip-<scene id>, so keep every
  scene self-contained: it starts on a blank page and opens what it needs with c-card.
  The playlist's summary for a clip is its first sentence, so make that sentence say
  what the feature is for. The actions are in clips.ts (prefixed c-), and each one
  checks what its paragraph claims.

  Narration costs voice characters: keep each clip to a few short paragraphs.
-->

# Feature clips

## Validate your data {#validate}

[do: c-card validate]
Validate data checks a whole file against any release of the standard, not just the working draft.

[do: c-upload]
Upload a file, here a food bank's shifts, and pick the release your data follows.

[do: c-validate]
The report groups problems by the record they're about, in plain words. Here, a minimum age is written as text, not a number.

[do: c-report-downloads]
Download the report as JSON, or as a standard SHACL report.

[do: c-validate-api]
And from your own code, the same check is one POST to the standard's address.

## Describe a use case {#interview}

[do: c-card use-cases]
Anyone can describe how they'd use the standard, in a short interview.

[do: c-start-interview]
It asks one question at a time. Type, or tap the mic and talk.

[do: c-answer]
As you answer, the use case fills in beside the conversation, with what's still to cover.

[do: c-interview-privacy]
The transcript is saved privately, and the use case stays private until you share it.

## A meeting, turned into requirements {#meeting}

[do: c-card meetings]
Concord turns meetings into requirements.

[do: c-add-meeting]
Upload a transcript, or invite Concord's bot to join the call.

[do: c-open-meeting]
Concord pulls out use cases, terms, competency questions, open questions and decisions.

[do: c-meeting-transcript]
Lines that fed a use case are tagged with it, so you can check the speaker's own words.

## Reports from coding agents {#agents}

[do: c-card agents]
Coding agents connected to Concord report the gaps they find in the standard.

[do: c-agent-details]
This one came from Claude Code, exporting weekly shifts. Triage checks the standard first, and suggests existing terms that might already cover it.

[do: c-connect-agent]
Connect an agent shows how to add Concord to Claude Code, or any agent that speaks MCP.

## Voting on a breaking change {#vote}

[do: c-end-review]
[pause: 0]

[do: c-card vote]
When its comment period ends, a breaking change goes to a vote of the working group.

[do: c-vote-rules]
The decision panel says what the vote needs: half the voters taking part, and two thirds saying yes.

[do: c-vote-yes]
Priya votes yes.

[do: c-tally]
The other members here are simulated, and they've voted too. The panel shows the count, and the turnout so far.

## Setting the rules {#governance}

[do: c-card governance]
Each standard sets its own rules for deciding changes, and anyone can read them.

[do: c-pick-template]
An owner can start from a template, like lazy consensus, where silence means consent, and preview the result.

[do: c-policy-rules]
Then tune it: who signs off on each kind of change, how long reviews stay open, and when there's a vote.

[do: c-policy-banner]
[then: c-discard]
Nothing changes for anyone until it's saved.
