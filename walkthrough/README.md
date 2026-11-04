# Narrated walkthrough video

Records a narrated tour of Concord as an MP4, from an editable script, the same way every time. Re-run it after each release and the video shows that release.

```sh
pnpm walkthrough                        # voice from the environment (see below)
pnpm walkthrough --voice elevenlabs     # asks for ELEVENLABS_API_KEY without echoing it, if unset
pnpm walkthrough --draft                # no voice: captions only, for checking pacing and visuals
pnpm walkthrough --only intro,goals     # some scenes only
pnpm walkthrough --strict               # fail on UI drift (a button that's gone, a failed step)
```

It boots its own offline Concord (fresh demo data, simulated AI) on ports 8798 and 5184, so it doesn't touch a running `pnpm dev`. Output lands in `walkthrough/out/`:

| File | What |
| --- | --- |
| `concord-walkthrough.mp4` | 1920×1080, 30 fps H.264, AAC narration, soft English captions, a chapter per scene |
| `concord-walkthrough.vtt` | The captions, for YouTube or a web player |
| `chapters.txt` | Chapter timestamps in YouTube's description format |
| `report.json` | Voice, scenes recorded and skipped, platform features found, stand-ins used, warnings |

Needs Node 22.13+, pnpm, ffmpeg, and Playwright's Chromium (`pnpm exec playwright install chromium`). For the reasoner to show as passing, run `./toolkit/setup.sh` first (HermiT needs Java).

## Changing the script

The words are in [narration.md](narration.md); what happens on screen is in [scenes.ts](scenes.ts).

```md
## Exploring a standard {#explore}

[do: open-browse]
Let's look inside. The Browse page shows the classes and their relationships…
```

- `## Title {#id}` starts a scene and a video chapter. `requires=forks,jsClasses` records the scene only when the hub has those features; `unless=forks` marks a fallback.
- Each paragraph is one narration clip. `[do: action args]` above a paragraph runs as it starts, while it's spoken; `[then: action]` above a paragraph runs after it's spoken; `[pause: 1.5]` holds in silence.
- The next paragraph starts once both the narration and the actions have finished, so timing takes care of itself: rewrite a sentence and the video re-times around it.
- Voices are cached in `walkthrough/.cache/voice/` by their exact words, so after an edit only the changed paragraphs are sent to the voice service.
- Words the voice might say wrongly (SHACL, SPARQL, ODI…) go in [lexicon.json](lexicon.json). Captions keep the written spelling.
- `pnpm walkthrough --list-actions` lists the actions. To add one, add a function to `actions` in scenes.ts. Use the `Director` helpers (`click`, `type`, `highlight`, `chapter`…): they move a visible pointer and fail softly, so a renamed button gives a warning, not a ruined recording.

When the app changes, run `pnpm walkthrough --draft --strict`. It takes a few minutes and fails on the first step that no longer works; CI does the same on every pull request that touches the walkthrough.

## Voices

The script is written to be listened to, so the voice matters. In order of preference:

| `--voice` | Service | Key | Notes |
| --- | --- | --- | --- |
| `elevenlabs` | ElevenLabs `eleven_multilingual_v2` | `ELEVENLABS_API_KEY` | **Recommended.** The most natural long-form narration, and it uses each paragraph's neighbours so clips flow into each other. Default voice "George", a warm British narrator; any voice id works with `--voice-id`. A full recording is about 9,000 characters, well within the Starter plan. |
| `openai` | OpenAI `gpt-4o-mini-tts` | `OPENAI_API_KEY` | Very good, and steerable with a style brief (`DEFAULT_STYLE` in lib/tts.ts). Default voice `sage`. |
| `google` | Google Cloud Chirp 3 HD | `GOOGLE_TTS_API_KEY`, or `GOOGLE_TTS_USE_GCLOUD=1` | Good, and cheapest. Default voice `en-GB-Chirp3-HD-Charon`. |
| `say` | macOS `say` | none | Quick local drafts only. |
| `silent` | none | none | Silence sized to the words, with captions. `--draft` uses it. |

With no `--voice`, the first provider whose key is set is used, then `say` on a Mac, then `silent`. Keys come from the environment; if a chosen provider's key is missing and you're at a terminal, it asks without echoing. Keys are never written to disk or to the output.

`--voice-id`, `--model` and `--rate 0.95` fine-tune the voice. Changing any of them re-voices everything.

## What's real and what's scripted

Everything in the hub is the real app, driven by Playwright. The sample app ([sample-app/](sample-app/)) is a real app whose code is edited on camera and reloaded. The Claude Code terminal is a scripted replay drawn in [stage/terminal.html](stage/terminal.html): its words are fixed so the video is the same every time, but every MCP tool result it shows comes from a real call to the Concord being recorded, and the edits it shows are applied to the app for real.

Code and the terminal show the public hub address (`--shown-hub`, default `https://standards-concord.vercel.app`); requests to it are answered by the hub being recorded.

Some scenes need platform features that may not be on every hub: development forks (`forks`), generated JavaScript classes (`jsClasses`), SHACL compact syntax (`shaclc`), app checks with autopilot voting (`appChecks`) and OAuth sign-in with the Connect page (`connectPage`). The recorder detects them and skips scenes that need missing ones (`report.json` says which). `--features forks,-shaclc,auto` overrides detection.

If the hub can't serve generated JavaScript classes yet, the sample app is given a stand-in module with the same shape ([sample-app/fallback/volunteering.js](sample-app/fallback/volunteering.js)) and the run ends with a warning. `--no-shims` refuses instead. CDN modules (n3, @rdfjs/wrapper) are always served from local bundles so recordings work offline.

## Recording against another hub

`--hub https://standards-concord.vercel.app` records a deployed hub instead of a local one. It needs `DEMO_MODE` on that hub (it signs in as a demo account and creates an MCP token), and it adds a fork and a change request to the shared demo, so prefer the local default.

## Releases

[.github/workflows/walkthrough.yml](../.github/workflows/walkthrough.yml) records the video when a GitHub release is published (or on demand from the Actions tab) and attaches the MP4, captions and chapters to the release. Add `ELEVENLABS_API_KEY` as a repository secret to get the narrated version; without it the workflow records a captioned draft.
