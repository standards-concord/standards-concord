---
title: Concord: designing data standards together
---

<!--
  The script for the narrated walkthrough video. Edit the words freely: the recorder
  re-voices only the paragraphs that changed, and the video re-times itself to fit.

  How it works
  - "## Title {#id}" starts a scene. Add requires=forks,jsClasses to record a scene only
    when those platform features exist, or unless=forks for a fallback scene.
  - Each paragraph is one narration clip.
  - [do: action args] runs as the paragraph below it starts, while it is being spoken.
    [then: action], also above a paragraph, runs once that paragraph has been spoken.
    Actions are defined in scenes.ts; `pnpm walkthrough --list-actions` lists them.
  - [pause: 1.5] holds for a moment in silence.
  - Pronunciations for the voice (OWL, SHACL, SPARQL…) are in lexicon.json.

  Writing for the ear
  - Short sentences, one idea each. Say what's on screen as it appears.
  - Contractions and plain words. Read it aloud before committing.
  - Avoid lists of more than three things in one breath.
-->

# Concord walkthrough

## Welcome {#intro}

[do: title-card]
Hi, and welcome to Concord. It's a prototype from the Open Data Institute for designing data standards together, in the open.

[do: open-hub]
In the next few minutes I'll show you what Concord is for, how a standard grows from a conversation into a published release, and then the part I enjoy most: building an app against one of these standards with a coding agent.

[do: point-hub-card]
This is the hub. Each card is a standard that a community looks after. We'll follow the volunteering standard, which describes volunteering opportunities, the organisations that offer them, and the people who give their time.

## What Concord is for {#goals}

[do: open-overview]
Every standard here is an ontology, written in OWL, the web's language for describing concepts and how they relate.

[do: highlight-health]
Concord has three goals. The first is rigour. Standards are strict OWL, a reasoner keeps them logically consistent, and they follow the FAIR principles, so data built on them is easy to find, reuse and combine.

[do: highlight-members]
The second is that the people who use a standard should shape it, whether they join a call, talk to an interviewer, or are a coding agent working on someone's app.

[do: clear-highlight]
And the third is governance without endless meetings. Every change is classified, checked and reviewed asynchronously, under rules the community agrees for itself.

## Exploring a standard {#explore}

[do: open-browse]
Let's look inside. The Browse page shows the classes and their relationships, so you can get a feel for the model before you read a line of code.

[do: open-formats turtle]
Source and export shows the same ontology however you need it. Turtle is the canonical form, and it's what we keep in git.

[do: show-format linkml]
LinkML is there too, for teams that generate schemas and documentation from one model.

[do: show-format shacl]
And there are SHACL shapes, generated from the OWL, for validating data.

## Readable shapes {#shaclc requires=shaclc}

[do: show-format shaclc]
The shapes are also available in SHACL compact syntax, which is far easier to read. Each shape fits on a few lines.

## Classes for developers {#classes-tab requires=jsClasses}

[do: show-format typescript]
And for developers there's a Classes format: JavaScript and TypeScript classes generated from those shapes, which an app can import straight from the standard's address. We'll use them in a moment.

## Querying in the browser {#query}

[do: open-query]
On the Query page you can ask questions of the ontology in SPARQL. The query engine is compiled to WebAssembly and runs right here in your browser.

[do: run-query]
There's a visual builder for people who'd rather not write SPARQL, and the results come straight back.

## Gathering requirements {#requirements}

[do: open-use-cases]
Changes start with requirements. People describe how they'd use the standard as use cases, following Elisa Kendall's approach, with competency questions the ontology must be able to answer.

[do: open-meetings]
Requirements also come from meetings. You can upload a Google Meet transcript, or invite a bot that joins the call, takes notes, and asks clarifying questions in the chat.

## Changing the standard {#governance}

[do: open-changes]
Requirements become change requests. The model never writes the ontology directly. It proposes terms, and Concord compiles them into validated edits.

[do: open-first-change]
Each change is classified as a patch, a minor change or a major one, using explicit versioning rules. Then it's validated: strict checks, the reasoner, the FAIR checks, and a test for every competency question.

[do: highlight-governance-card]
Finally it's reviewed under the standard's governance policy. That might mean a steward's sign-off, a review period where silence means consent, or a formal vote.

[do: open-governance]
The policy is the community's choice. Start from a template, like lazy consensus or a W3C-style working group, and tune it: who signs off, how long reviews run, and what's automated.

[do: open-releases]
Approved changes go into releases. Each release gets a proper semantic version, every format, and for major versions, a migration script.

## Building with the standard {#developer}

[do: chapter developer]
So that's the standards side. Now let's put on a developer's hat.

[do: open-app]
This is Helping Hands, a small web app that lists volunteering opportunities near you. Its data is described with the volunteering standard.

[do: show-app-code]
Here's the interesting bit. The app doesn't hand-write any code for the data model. It imports JavaScript classes straight from the standard's web address, and Concord generates those classes from the standard's SHACL shapes.

## Connecting Claude Code {#install}

[do: install-mcp]
To work on the app, I'll use Claude Code, connected to Concord through its MCP adapter. In a terminal, that's a single command.

## Signing in {#connect requires=connectPage}

[do: open-connect-page]
The first time Claude Code uses it, a browser window opens so you can sign in to the hub. And the Connect page has one-click install links for other agents too, like Codex and Cursor.

## A feature the standard can't describe yet {#ask}

[do: start-claude]
Here's the feature. Volunteers want to log the hours they've given, and organisers want to see the total for each opportunity.

[do: ask-feature]
I'll ask Claude Code to build it, using the volunteering standard for the data.

[do: claude-searches]
Before writing any code, Claude checks the standard. It searches for anything about hours, and finds hours per week on time commitment.

[do: claude-explains-gap]
But that's the time a role expects, not time someone actually gave. So the concept we need is missing from the standard.

## A fork of my own {#fork requires=forks}

[do: claude-creates-fork]
In the past, that's where you'd stop and wait for the standard to change. Instead, Claude creates a fork: my own development copy of the ontology, right on the hub.

[do: claude-edits-fork]
It adds the missing class to the fork, a volunteering activity, with the hours given, who gave them, which opportunity, and the date. The new terms keep the standard's own namespace, so my data stays valid when they land upstream.

[do: open-fork-page]
And here's the fork in the hub, next to the standard it came from, with its changes and a link back to the main ontology.

[do: claude-proposes-fork]
Claude also proposes the change upstream, so the community can consider it. Nobody has to wait for anybody.

## Proposing the change {#propose unless=forks}

[do: claude-proposes-change]
Claude proposes the missing concept to the community as a change request, with the context of what it was building, and carries on.

## Classes straight from the fork {#fork-module requires=forks,jsClasses}

[do: show-fork-module]
The fork has its own address, and it serves generated classes just like the main standard does. Here's the module, with a class for the new volunteering activity.

## Building the feature {#classes requires=forks}

[do: claude-switches-import]
So the only change Claude needs to make to use the new concept is the import line. It now points at my fork.

[do: claude-writes-feature]
Then it writes the feature itself: reading activities through the generated classes, and adding up the hours for each opportunity.

## The finished feature {#result requires=forks}

[do: open-app-feature]
Back in the app, each opportunity now shows the hours volunteers have given, and there's a running total for me at the top.

[do: log-hours]
Let's log a couple of hours at the food bank. And the totals update straight away.

## Meanwhile, on the hub {#review}

[do: open-proposed-change]
Meanwhile, my proposal is on the hub like any other change request. Concord has classified it as a minor change, because it only adds terms, and the validation has passed.

## Autopilot for app owners {#autopilot requires=appChecks}

[do: open-app-checks]
Other app owners don't need to read every proposal either. They can connect their app's tests to Concord and switch on autopilot.

[do: post-app-check]
Now, whenever a change is proposed, their tests run against it. If nothing breaks, Concord votes yes on their behalf. Changes move through without waiting on a dozen people.

## Back to the main standard {#merge requires=forks}

[do: land-upstream]
A few days later, the change has been approved and released in a new version of the standard.

[do: new-session-check]
At the start of my next session, Claude checks my forks, sees that the volunteering activity is now in the released standard, and offers to move me back.

[do: claude-migrates]
It's one line again: the import goes back to the main standard. The app works exactly as before, and my fork has done its job.

## Wrapping up {#outro}

[do: outro-card]
That's Concord. Rigorous, open standards that grow from the people who use them, with governance that doesn't need a meeting, and a development flow where nobody gets blocked.

It's an early prototype, and we'd love your feedback. Try it yourself at the link below, and thanks for watching.
