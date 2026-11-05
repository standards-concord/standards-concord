# Narrated walkthrough videos

Records two narrated videos of Concord as MP4s, each from an editable script:

- **The tour** ([narration.md](narration.md), `concord-walkthrough.*`): what Concord is for, how a standard grows into a release, and building an app on it with a coding agent.
- **How to take part** ([feedback.md](feedback.md), `concord-feedback.*`): for alpha testers. The welcome page, the guided walkthrough, simulating the others, and how to give feedback. About three minutes.

Both are embedded on the alpha landing page, `/welcome` (the link to send testers), which plays the latest GitHub release's copies (see [Releases](#releases)).

The tour is about nine minutes with the developer story, about four without it (the intro states the estimated length of the scenes being recorded, and the run warns if the video is more than a minute and a half off). Runs are repeatable, not frame-identical. The same scenes play in the same order with the same words, the recorded hub's clock starts at a fixed moment and its ids come from a seeded sequence, but timings shift by fractions of a second and a re-voiced paragraph may not sound exactly the same. Re-run it after each release and the video shows that release.

```sh
pnpm walkthrough                        # both videos, voice from the environment (see below)
pnpm walkthrough --video feedback       # one video: tour or feedback
pnpm walkthrough --voice elevenlabs     # asks for ELEVENLABS_API_KEY without echoing it, if unset
pnpm walkthrough --draft                # no voice: captions only, for checking pacing and visuals
pnpm walkthrough --only intro,goals     # some scenes only (of the video that has them)
pnpm walkthrough --strict               # fail on any warning: UI drift, a narrated outcome not shown, a page or request error
pnpm walkthrough --publish              # a release video: strict, no stand-ins, no outside requests, a real voice
```

It boots its own offline Concord (fresh demo data, simulated AI, no FAIR lookups on the internet, a clock fixed to start at 23 November 2026, seeded ids) on ports 8798 and 5184, so it doesn't touch a running `pnpm dev`. Each video is recorded in its own run, one after the other. That Concord serves `walkthrough/out/` as its videos (`MEDIA_DIR`), so the feedback video's shot of the welcome page shows the tour just recorded. Output lands in `walkthrough/out/`, once per video (`concord-walkthrough` and `concord-feedback`):

| File | What |
| --- | --- |
| `<name>.mp4` | 1920×1080, 30 fps H.264, AAC narration, soft English captions, a chapter per scene |
| `<name>.vtt` | The captions, for YouTube or a web player |
| `<name>.transcript.md` | The narration as text, one section per chapter, for accessibility and review |
| `<name>.chapters.txt` | Chapter timestamps in YouTube's description format |
| `<name>.report.json` | Voice, scenes recorded and skipped, platform features found, stand-ins used, blocked outside requests, caption timing source, warnings |

Needs Node 22.13+, pnpm, ffmpeg, and Playwright's Chromium (`pnpm exec playwright install chromium`).

## Changing the script

The words are in [narration.md](narration.md) and [feedback.md](feedback.md); what happens on screen is in [scenes.ts](scenes.ts).

```md
## Exploring a standard {#explore}

[do: open-browse]
Let's look inside. The Browse page shows the classes and their relationships…
```

- `## Title {#id}` starts a scene and a video chapter. `requires=forks,jsClasses` records the scene only when the hub has those features; `unless=forks` marks a fallback.
- Each paragraph is one narration clip. `[do: action args]` above a paragraph runs as it starts, while it's spoken; `[then: action]` above a paragraph runs after it's spoken; `[pause: 1.5]` holds in silence.
- To time an action to a word, put `{@action args}` just before the word in the paragraph: it runs when the voice reaches that word (from ElevenLabs' character timestamps; other voices use an estimate from text length), after the paragraph's `[do:]` actions. Marks are neither spoken nor captioned, so adding or moving one never re-voices anything. A mark whose action starts more than 0.75 s after its word is a warning (so `--publish` fails); `report.json` lists every mark's lateness under `sync`.
- Each paragraph is voiced and placed on its own, at the moment its step starts, so timing never drifts across a video. Frames are placed at the time Chromium painted them, not when they reached the recorder, so the picture doesn't lag the voice on a busy machine (`report.json` → `frameLatency`).
- `[if: jsClasses]` above a paragraph keeps it only when the hub has that feature, and `[if: !jsClasses]` only when it doesn't. The intro and outro use it so they promise only what the recorded scenes show. `{minutes}` becomes the estimated length of the recorded scenes, in words.
- The next paragraph starts once both the narration and the actions have finished, so timing takes care of itself: rewrite a sentence and the video re-times around it.
- Voices are cached in `walkthrough/.cache/voice/` by their exact words (not their neighbours'), so after an edit only the changed paragraphs are sent to the voice service. Release runs restore the narration kept with the last release, so a release re-voices only what changed.
- Voice characters are limited, and ElevenLabs flags bursts of use. A run with a paid voice may send at most `VOICE_CHAR_BUDGET` characters (or `--voice-budget`; default 2,500, 0 means no limit), across all the videos it records and counting every retry. It works out first what each video would send and refuses before sending anything if the total is over; a send that would still pass the budget (a retry, or a cached clip that went missing) is refused before it goes. With ElevenLabs it also reads the account's usage first (even with no run budget) and refuses unless what's left covers the total plus 10%. If the usage can't be read because of an outage or an odd reply, it refuses. Only a key that isn't allowed to read usage goes ahead, under the run budget alone, and says so in the log. Re-record sparingly, and keep script edits for a release small. For a first or full recording (both scripts are about 8,000 characters), run the workflow by hand with a larger budget and the release tag to attach to.
- Words the voice might say wrongly (SHACL, SPARQL, ODI…) go in [lexicon.json](lexicon.json). Captions keep the written spelling.
- Captions are split into short phrases (at most 84 characters, broken at commas where possible). With ElevenLabs they are timed from the voice's own character timestamps; other voices, or an ElevenLabs reply whose timestamps are missing or don't match the text, fall back to an estimate from text length (`report.json` says which).
- `pnpm walkthrough --list-actions` lists the actions. To add one, add a function to `actions` in scenes.ts. Use the `Director` helpers (`click`, `type`, `highlight`, `chapter`…): they move a visible pointer and fail softly, so a renamed button gives a warning, not a ruined recording.
- When the narration claims an outcome ("the results come straight back", "validation has passed", "the totals update"), the action checks it with `d.claim(...)` or `d.claimVisible(...)`. An action that ran but didn't produce what the words say is a warning, so `--strict` and `--publish` fail on it. Uncaught script errors, console errors, failed requests and HTTP error responses in the browser are warnings too, wherever they happen.

When the app changes, run `pnpm walkthrough --draft --strict`. It takes a few minutes and fails on the first step that no longer works; CI does the same on every pull request that touches the walkthrough.

## Voices

The script is written to be listened to, so the voice matters. In order of preference:

| `--voice` | Service | Key | Notes |
| --- | --- | --- | --- |
| `elevenlabs` | ElevenLabs `eleven_multilingual_v2` | `ELEVENLABS_API_KEY` | **Recommended.** The most natural long-form narration, and it uses each paragraph's neighbours so clips flow into each other. Default voice "George", a warm British narrator; any voice id works with `--voice-id`. A full recording of both videos is about 8,000 characters, so re-voice only what changed. Audio is 128 kbps MP3 (`mp3_44100_128`), which every plan can produce; set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_192` on Creator or above. Only MP3 formats are accepted. A fixed seed makes re-voicing more repeatable, though not identical. |
| `openai` | OpenAI `gpt-4o-mini-tts` | `OPENAI_API_KEY` | Very good, and steerable with a style brief (`DEFAULT_STYLE` in lib/tts.ts). Default voice `sage`. |
| `google` | Google Cloud Chirp 3 HD | `GOOGLE_TTS_API_KEY`, or `GOOGLE_TTS_USE_GCLOUD=1` | Good, and cheapest. Default voice `en-GB-Chirp3-HD-Charon`. |
| `say` | macOS `say` | none | Quick local drafts only. |
| `silent` | none | none | Silence sized to the words, with captions. `--draft` uses it. |

With no `--voice`, the first provider whose key is set is used, then `say` on a Mac, then `silent`. Keys come from the environment; if a chosen provider's key is missing and you're at a terminal, it asks without echoing. Keys are never written to disk or to the output.

`--voice-id`, `--model` and `--rate 0.95` fine-tune the voice. Changing any of them, the output format or the voice settings in lib/tts.ts re-voices everything. Requests time out after two minutes and are retried on network errors, rate limits and server errors.

## What's real and what's scripted

Everything in the hub is the real app, driven by Playwright. The sample app ([sample-app/](sample-app/)) is a real app whose code is edited on camera and reloaded. Claude Code (on the web) is a scripted replay drawn in [stage/claude-web.html](stage/claude-web.html): its words are fixed so each recording tells the same story, but every MCP tool result it shows comes from a real call to the Concord being recorded, and the edits it shows are applied to the app for real.

The video says so itself. While the terminal is on screen a caption reads "Scripted demonstration: real Concord tool calls; prepared agent responses and code", and the narration says it out loud. The autopilot scene reports a passing CI run to Concord rather than running one, and is labelled "Simulated CI" on screen and in the narration.

Code and the terminal show the public hub address (`--shown-hub`, default `https://standards-concord.vercel.app`); requests to it are answered by the hub being recorded.

Some scenes need platform features that may not be on every hub: development forks (`forks`), generated JavaScript classes (`jsClasses`), SHACL compact syntax (`shaclc`), app checks with autopilot voting (`appChecks`) and OAuth sign-in with the Connect page (`connectPage`). The recorder detects them and skips scenes that need missing ones (`report.json` says which). `--features forks,-shaclc,auto` overrides detection.

The developer story is about generated JavaScript classes, so its scenes require `jsClasses`. In a draft against a hub that can't serve them yet, the sample app is given a stand-in module with the same shape ([sample-app/fallback/volunteering.js](sample-app/fallback/volunteering.js)), the app is captioned "Preview: … stand-in module" on screen, the scenes that show the hub's own Classes pages are skipped, and the run ends with a warning. `--no-shims` (and `--publish`) refuse stand-ins, so a published video simply leaves the developer story out until the hub has the feature.

During a recording the browser may only reach the exact origins of the hub being recorded and the local stage server. Chromium is launched behind a local allowlisting proxy ([lib/egress.ts](lib/egress.ts)), loopback included, so every connection it makes is checked: each redirect hop, event streams, service-worker fetches, and HTTPS and WebSocket tunnels. Origins match exactly, scheme included. A tunnel's first bytes decide its scheme: TLS may only reach an allowed `https:` origin, opening with a complete ClientHello that names that host (the proxy checks its framing, fixed fields and list-valued extensions; the TLS server, always an allowed origin, judges the rest); anything else is parsed by the proxy as HTTP, every request on it, and must be for an allowed `http:` origin with exactly one, matching `Host`. A WebSocket handshake carries nothing further until the server accepts it. Requests that don't fit these rules are refused. WebRTC can't go around the proxy: Chromium's `disable_non_proxied_udp` policy leaves it only TCP through the proxy, which refuses and reports it like anything else, and pages get no working `RTCPeerConnection` ([lib/browser.ts](lib/browser.ts)). An attempt that never sends anything isn't reported, as there's nothing to refuse. Requests the proxy refuses, including ones it can't parse, are listed in `report.json`; `--strict`, `--check --strict` and `--publish` all fail if there was any. Three limits remain: the proxy can't see inside TLS (the browser checks the certificate against the name, but a server with certificates for several names could be asked for another inside the encrypted stream); it resolves host names itself and doesn't pin their addresses; and Chromium's own background services aren't individually audited (the recording browser starts with a fresh profile and no sign-in). CDN modules (n3, @rdfjs/wrapper) are served from local bundles, and the web fonts the app loads from Google Fonts are served from [fonts/](fonts/), so a recording needs no network. If the app starts using a font that isn't there yet, a normal run downloads it once from Google Fonts (outside the browser, which can't reach it) and saves it (commit the new files); a `--publish` run refuses instead.

Video frames are counted against the clock, so a slow encoder never shifts the timeline; it only queues frames in memory. That queue is capped at 1 GB, checked before every frame, and a recording that hits it stops with an error rather than running the machine out of memory.

`report.json` lists the Node, Chromium, ffmpeg and OS versions used, for comparing two recordings. GitHub's `ubuntu-24.04` runner image is updated weekly and its ffmpeg comes from apt, so those can change between releases; the report says when they did.

## Recording against another hub

`--hub https://standards-concord.vercel.app` records a deployed hub instead of a local one. It needs `DEMO_MODE` on that hub (it signs in as a demo account and creates an MCP token), and it adds a fork and a change request to the shared demo, so prefer the local default.

## Releases

[.github/workflows/walkthrough.yml](../.github/workflows/walkthrough.yml) records both videos when a GitHub release is published (or on demand from the Actions tab) with `--publish`, and attaches each one's MP4, captions, transcript and chapters to the release. Only a clean run is attached: one failed step, stand-in, warning or outside request in either video and nothing is uploaded.

- The welcome page (`/welcome`) plays the videos of the newest release that has them. The API server reads that release from GitHub (`MEDIA_REPO`, default `standards-concord/standards-concord`), downloads each file once per release into its data directory, and serves it from `/api/media/`, so captions and seeking work from Concord's own origin. Set `MEDIA_DIR` to serve a local folder instead, such as `walkthrough/out/` after a recording. Until a release has the videos, the page says they're on their way.

- Add `ELEVENLABS_API_KEY` as a repository secret for the narration. Without a voice key, release runs are skipped with a notice. Set the repository variable `ELEVENLABS_OUTPUT_FORMAT` to change the audio format.
- The recording job has read-only access and doesn't keep the checkout's credentials; a separate job with write access only attaches the files.
- Each release also carries `walkthrough-voice.tar.gz`, the approved narration audio. The next release restores it, so only paragraphs whose words or voice settings changed are re-voiced, however long ago the last release was.
- The runner is pinned to `ubuntu-24.04`, and Node packages, Playwright and its Chromium come from the lockfile. See above for what that does and doesn't pin.
