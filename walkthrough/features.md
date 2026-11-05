---
title: Concord, a closer look: one change from start to finish
---

<!--
  The script for the third video: the features the tour (narration.md) moves past
  quickly or skips. It follows one change from a term's page, through review, into git
  and a release, and out to the standard's public address, then checks some data
  against the standard. The format is the same as narration.md; the actions are in
  features.ts (prefixed f-).

  The git and curl shots are real commands run on the recorded hub (read-only), so they
  need a hub the recorder started itself (requires=gitRepo). Keep the words true to
  what they show: each action checks what its paragraph claims.
-->

# A closer look

## Welcome {#intro}

[do: f-title-card]
Welcome back to Concord. The tour showed the big picture. This video takes a closer look.

[do: f-open-overview]
In about {minutes} minutes, we'll follow one small change from a term's page all the way to a published release, see what happens in git along the way, and then check some data against the standard.

## A healthy standard {#health}

[do: f-open-health]
Every change is checked against the whole standard: strict OWL lint, a reasoner, FAIR checks, and the competency questions the ontology must answer.

[do: f-recheck-browser]
The reasoner is sparq, compiled to WebAssembly, so you can run it again right here in your browser. Every class is satisfiable, and it agrees with the server.

[do: f-show-fair]
The FAIR checks follow published tests, so you can see exactly why a standard is findable, accessible, interoperable and reusable.

## Seeing the model {#diagram}

[do: f-open-diagram]
Browse also draws the model as a diagram, showing what data each class carries, and how the classes connect.

## Editing a term {#edit}

[do: f-open-term]
Now I'm Tom, one of the editors. This is the term "skill". Its definition talks about a person, but in this standard it's volunteers who bring skills to roles.

[do: f-edit-term]
So I'll fix it right here, on the term's page. {@f-type-definition} I rewrite the definition so it talks about volunteers and roles. Then I {@f-confirm-meaning} confirm it still means the same thing, and say why.

[do: f-propose]
Propose change. The term itself doesn't change yet. My edit becomes a change request, for others to review.

## Review {#review}

[do: f-open-change]
Concord has already classified it as a patch: clearer wording that doesn't change what the term means.

[do: f-show-triples]
The triples view shows exactly which statement is removed and which is added.

[do: f-show-checks]
And the checks have passed: lint, the reasoner and the competency questions all ran with the change applied.

[do: f-show-decision]
The decision panel follows the standard's governance policy. For a patch, that's one approval from an editor or a steward, and a day for anyone to comment.

[do: f-approve]
Priya, the steward, approves it.

[do: f-day-passes]
A day later the review period is over, with no objections, so Concord merges the change on its own.

## What happens in git {#git requires=gitRepo}

[do: f-git-log]
Under the hood, every standard is an ordinary git repository. Here's this one's history. Each merged change request is a commit, named after the request, and each release is a tag.

[do: f-git-show]
This is Tom's commit. The change is a small, readable diff to the Turtle file. That's why Turtle is the canonical form: reviewers and tools can see exactly what changed.

[do: f-git-forks]
Development forks live here too, as branches of the same repository.

## Releasing {#release}

[do: f-open-releases]
Merged changes wait for a release. Priya drafts one, and Concord works out the version from the changes it includes. They're all patches, so this is a patch release.

[do: f-publish]
Publish.

## Tagged in git {#tag requires=gitRepo}

[do: f-git-tag]
Back in git, the release is one more commit and a tag. Every format is written under its version's folder, so each version's address keeps working for good.

## The standard's own address {#public}

[do: f-open-public]
Outside Concord, the standard lives at its own address. This is the public page people find there. It already shows the new version, with downloads in every format.

[do: f-curl]
And the same address serves machines. Ask for Turtle, and Turtle is what you get. That's content negotiation, one of the FAIR checks we saw earlier.

## Checking data {#check-data}

[do: f-open-check]
Finally, data. Check data validates your own data against SHACL shapes generated from the standard. It runs in your browser too, so the data never leaves the page.

[do: f-paste-data]
Here's some data about a food bank shift, with one mistake in it.

[do: f-check]
Press Check, and each problem reads as a plain sentence, written with your data's own prefixes.

[do: f-hover]
It's underlined in the editor, and hovering shows the same explanation.

[do: f-jump]
Click the problem to jump straight to it. The minimum age is written as text, but it should be a whole number, and the report even says how to write it.

[do: f-fix]
Write it that way, check again, and the data conforms.

[do: f-open-validate]
For files in other formats, or a check against a particular release, Validate data gives a full report to download. And the same check is one API call to the standard's own address.

## Wrapping up {#outro}

[do: f-outro-card]
That's one change, from a term's page to a tagged release, checked, reviewed, and recorded in git at every step. Thanks for watching.

[pause: 1.5]
