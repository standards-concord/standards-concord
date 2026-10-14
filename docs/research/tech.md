# Tech research: collaborative ontology platform prototype (TypeScript/Node)

Researched 2026-10-14. npm/PyPI versions were checked live with `npm view` and `pip index versions`. Where I could not confirm an exact request or response shape against a primary doc, it is marked **(verify)**.

| Package | Version (2026-10) |
|---|---|
| `@modelcontextprotocol/sdk` (v1 line) | 1.32.1 |
| `@modelcontextprotocol/server` / `@modelcontextprotocol/node` / `@modelcontextprotocol/express` (v2 line) | 2.3.1 / 2.1.1 / 2.0.2 |
| `zod` | 4.6.7 |
| `@solid/community-server` | 7.2.0 |
| `@inrupt/solid-client-authn-node` / `-core` | 5.0.1 |
| `@inrupt/solid-client` | 4.0.0 |
| `n3` | 2.13.12 |
| `eyereasoner` | 21.1.25 |
| `@ontologos/wasm`, `ontologos` | 1.1.4 (experimental) |
| `googleapis` / `@googleapis/meet` | 185.0.0 / 9.1.0 |
| `@googleworkspace/meet-addons` | 1.2.0 |
| `@meeting-baas/sdk` | 6.2.12 |
| `@skribby/sdk` | 0.11.0 |
| `better-auth` | 1.7.7 |
| `arctic` | 3.7.0 |
| `@auth/express` / `@auth/core` | 0.12.3 / 0.41.3 |
| `passport` / `passport-google-oauth20` / `passport-github2` | 0.7.0 / 2.0.0 / 0.1.12 |
| `openid-client` | 6.8.8 |
| PyPI `linkml` / `linkml-runtime` | 1.12.1 |
| PyPI `schema-automator` | 0.5.7 |
| PyPI `owlready2` | 0.51 |
| PyPI `py-horned-owl` | 2.0.0 |
| ROBOT (GitHub release) | v1.9.10 |

---

## 1. Google Meet bot participation

### 1a. Google Meet Media API: not usable for new projects
- **Status:** Developer Preview, and the overview page says *"The Google Meet Media API is no longer accepting new signups."* https://developers.google.com/workspace/meet/media-api/guides/overview
- **What it does:** receive only. It can consume real-time audio (3 mixed streams), up to 3 video streams, and participant metadata over a raw WebRTC connection that you build yourself (there is no SDK; you create the SDP offer and use data channels). It cannot send audio, video or chat into the meeting. It provides no transcript and no chat.
- **Access requirements:**
  - Every participant whose media you want must be enrolled in the preview.
  - It uses restricted OAuth scopes (`meetings.conference.media.readonly`, among others), which require Google app verification plus a security assessment.
  - The Workspace admin must enable the Meet Media API setting.
  - The host must consent (Calendar setting or an in-call dialog), and anyone in the call can revoke that at any time.
  - Encrypted or watermarked meetings are rejected.
  - For Gmail-hosted meetings, the host must be present.
  - Summary: https://www.recall.ai/blog/what-is-the-google-meet-media-api
- **Verdict:** not viable for this prototype.

### 1b. Meet REST API (v2): post-call transcripts, the official and supported path
- `GET https://meet.googleapis.com/v2/conferenceRecords?filter=space.meeting_code="abc-mnop-xyz"` returns the conference records.
- `GET https://meet.googleapis.com/v2/conferenceRecords/{rec}/transcripts` returns `transcripts[]`, each with `name`, `state` (`STARTED|ENDED|FILE_GENERATED`) and `docsDestination`.
- `GET https://meet.googleapis.com/v2/{parent=conferenceRecords/*/transcripts/*}/entries?pageSize=100&pageToken=…` returns `{ transcriptEntries[], nextPageToken }`.
  - Each `TranscriptEntry` has `name`, `participant`, `text`, `languageCode`, `startTime` and `endTime`.
  - Scopes: `meetings.space.created` or `meetings.space.readonly`.
  - Docs: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list
- **Constraints:**
  - Transcription must be switched on in the meeting, which needs a Workspace edition that includes Meet transcripts.
  - Entries appear only after the meeting ends. Google does not document how long that takes; in practice it is minutes.
  - Entries may differ slightly from the Google Docs transcript file.
- To learn when a transcript is ready, use the Workspace Events API (`google.workspace.meet.transcript.v2.fileGenerated`) or poll.
- Node: `npm i googleapis` (or `@googleapis/meet`), then `google.meet('v2').conferenceRecords.transcripts.entries.list({ parent })`.

### 1c. Google Meet add-ons (Workspace add-ons SDK)
- `@googleworkspace/meet-addons` (1.2.0) puts your web page in the Meet **side panel** and **main stage**, with shared state between participants (co-doing).
- It has **no access to call audio or transcripts**, and it does not join as a participant.
- It is useful as a UI surface, for example an "ontology feedback" side panel, but it cannot listen. https://developers.google.com/workspace/meet/add-ons/guides/overview

### 1d. Third-party meeting-bot services
All of these join as a visible participant: a headless Chrome instance signs in as a guest or a bot Google account, gets admitted from the lobby, and scrapes audio and captions.

**Recall.ai (hosted, commercial, the most complete)**
- Create the bot: `POST https://{region}.recall.ai/api/v1/bot/` with header `Authorization: Token <key>`.
  ```json
  {"meeting_url":"https://meet.google.com/abc-defg-hij","bot_name":"Ontology Scribe",
   "recording_config":{"transcript":{"provider":{"recallai_streaming":{"mode":"prioritize_low_latency","language_code":"en"}}},
                       "realtime_endpoints":[{"type":"webhook","url":"https://you/hook","events":["transcript.data"]}]},
   "automatic_audio_output":{"in_call_recording":{"data":{"kind":"mp3","b64_data":"<silent mp3>"}}}}
  ```
  The `realtime_endpoints` shape is marked **(verify)**: https://docs.recall.ai/docs/bot_create
- Chat: `POST /api/v1/bot/{id}/send_chat_message/` with `{"to":"everyone","message":"…"}`. On Meet, the only recipients are `everyone`, `host` and `everyone_except_host`. https://docs.recall.ai/v1.10/docs/chat-messages
- Speak: `POST /api/v1/bot/{id}/output_audio/` with `{"kind":"mp3","b64_data":"…"}`. This only works if `automatic_audio_output` was set when the bot was created. https://docs.recall.ai/docs/output-audio-in-meetings
- Voice agent: Output Media (`POST /api/v1/bot/{id}/output_media/`) renders a webpage that you host as the bot's camera and mic. https://docs.recall.ai/v1.10/docs/stream-media
- Use webhooks for bot status changes; status events are not delivered through `realtime_endpoints`. The rate limit is 120 requests/min.

**Attendee (open source Django app; self-host or app.attendee.dev)**
- Repo: https://github.com/attendee-labs/attendee. It ships as one Docker image and needs Postgres and Redis. Kubernetes is recommended in production.
- Create: `POST /api/v1/bots` with header `Authorization: Token <key>` and body `{"meeting_url":…, "bot_name":…}`.
  - Add `"websocket_settings":{"audio":{"url":"wss://you/ws","sample_rate":16000}}` for live audio.
  - Attendee pushes `{"trigger":"realtime_audio.mixed","data":{"chunk":<b64 PCM16 mono>,…}}` to your server.
  - Your server sends back `{"trigger":"realtime_audio.bot_output","data":{"chunk":…,"sample_rate":16000}}` to make the bot talk.
  - Docs: https://mintlify.wiki/attendee-labs/attendee/guides/realtime-audio
- Transcript: `GET /api/v1/bots/{id}/transcript` (partial results are available during the call). It uses third-party speech-to-text such as Deepgram.
- Chat: `POST /api/v1/bots/{id}/send_chat_message` with `{"to":"everyone","message":"…"}`. Reading chat is `GET …/chat_messages`.
- TTS: `POST /api/v1/bots/{id}/speech` with `{"text":"…","text_to_speech_settings":{"google":{"voice_language_code":"en-US","voice_name":"en-US-Casual-K"}}}`.
- Audio file: `POST /api/v1/bots/{id}/output_audio` with `{"type":"audio/mp3","data":"<b64>"}`.

**MeetingBaaS (hosted, with an open-source bot core)**
- `npm i @meeting-baas/sdk`, then:
  ```ts
  createBaasClient({ api_key, api_version: "v2" }).createBot({ meeting_url, bot_name })
  ```
- It has speech-to-text providers and webhooks. Speaking and chat support in v2 is not confirmed in the README **(verify)**. https://unpkg.com/@meeting-baas/sdk@6.2.0/README.md

**Skribby (hosted)**
- `@skribby/sdk` 0.11.0. It has a bot object with real-time transcript and chat methods, at lower cost than Recall. Docs: https://skribby.io/docs **(verify method names)**.

### Recommendation
For a bot that joins as a participant, listens live and can speak or post chat:

- **Primary:** **Attendee, self-hosted in Docker** (free, open source, has every capability needed), or **Recall.ai** if you want zero infrastructure and better reliability.
- Hide them behind a `MeetingBot` interface: `join(url)`, `onTranscript(cb)`, `say(text)`, `chat(text)`.
- **Supplement:** the Meet REST API for the authoritative transcript after the call (Workspace accounts only).
- **Optional:** a Meet add-on for an in-call side-panel UI.
- Skip the Media API.

Practical caveats:
- Meet guest bots wait in the lobby until someone admits them.
- Some Workspace domains block external guests. Recall and Attendee both support "signed-in" bots that use a Google account.

---

## 2. Solid: Community Solid Server v7 account API

CSS v7 replaced the old `/idp/register/` endpoint with a **JSON account API under `/.account/`**. Always discover URLs from `controls` rather than hard-coding them. Docs: https://communitysolidserver.github.io/CommunitySolidServer/latest/usage/account/json-api/

The keys under `controls` are:
- `account`: `create`, `logout`, `webId`, `pod`, `clientCredentials`
- `password`: `create`, `login`, `forgot`, `reset`
- `oidc`: `prompt`, `consent`, …

### Silent provisioning (run by the platform backend at Google/GitHub sign-in)

```ts
const BASE = 'http://css:3000/';
const j = (r: Response) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

// 1. Create an empty account. The response includes an `authorization` value (the account token).
let { controls } = await j(await fetch(BASE + '.account/'));
const { authorization } = await j(await fetch(controls.account.create, { method: 'POST' }));
const auth = { 'content-type': 'application/json', authorization: `CSS-Account-Token ${authorization}` };

// 2. Re-read controls with the token. They are now account-specific (…/.account/account/<uuid>/…).
({ controls } = await j(await fetch(BASE + '.account/', { headers: auth })));

// 3. (Optional) Add a password login so the user can later use their pod with other Solid apps.
await fetch(controls.password.create, { method: 'POST', headers: auth,
  body: JSON.stringify({ email: `${userId}@users.example.org`, password: randomSecret() }) });

// 4. Create the pod. With no settings.webId, CSS creates <pod>/profile/card#me and links it to the account.
const pod = await j(await fetch(controls.account.pod, { method: 'POST', headers: auth,
  body: JSON.stringify({ name: slug }) }));
// → { pod: 'http://css:3000/<slug>/', webId: 'http://css:3000/<slug>/profile/card#me', podResource, webIdResource }  (verify field names)

// 5. Client credentials bound to that WebID. The secret is shown only once, so store it encrypted.
const { id, secret } = await j(await fetch(controls.account.clientCredentials, { method: 'POST', headers: auth,
  body: JSON.stringify({ name: 'platform-backend', webId: pod.webId }) }));
```

Notes:
- `POST /.account/login/password/` with `{email,password,remember}` also returns `authorization`, for later sessions.
- To link an external WebID, use `POST controls.account.webId` with `{webId}`. It needs an ownership triple in that WebID's profile and then a second request.

### Backend reading and writing with client credentials

Option A, recommended: `@inrupt/solid-client-authn-node`.

```ts
import { Session } from '@inrupt/solid-client-authn-node';
import { overwriteFile, getFile } from '@inrupt/solid-client';
const session = new Session();
await session.login({ clientId: id, clientSecret: secret, oidcIssuer: BASE }); // auto refresh (keepAlive)
await overwriteFile(pod.pod + 'ontologies/core.ttl', new Blob([ttl], { type: 'text/turtle' }), { fetch: session.fetch });
// or plain: await session.fetch(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl });
```

Option B: manual DPoP with `@inrupt/solid-client-authn-core`.

```ts
const dpopKey = await generateDpopKeyPair();
const r = await fetch(BASE + '.oidc/token', { method: 'POST', headers: {
  authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64'),
  'content-type': 'application/x-www-form-urlencoded', dpop: await createDpopHeader(BASE + '.oidc/token', 'POST', dpopKey) },
  body: 'grant_type=client_credentials&scope=webid' });
const { access_token, expires_in } = await r.json();
const authFetch = await buildAuthenticatedFetch(access_token, { dpopKey });
```

Docs: https://communitysolidserver.github.io/CommunitySolidServer/latest/usage/client-credentials/

### Simpler approaches
- **One platform account, many pods.**
  - A single CSS account can own many pods and WebIDs. The backend logs in once, creates one pod (and WebID) per user, and mints client credentials per WebID.
  - This avoids storing a token for every account. Users can be given their own password login later.
- **Seeded pods.** Run `npx @solid/community-server -c @css:config/file.json -f ./data --seedConfig seed.json` with `[{ "email", "password", "pods":[{ "name" }] }]` for fixed demo users.
- **Narrow config.** For a prototype, `@css:config/file.json` (file backend with the account API and IdP) is enough. Run it with Docker: `solidproject/community-server:7`.

---

## 3. OWL reasoning from Node

| Option | Runtime | Capability | Notes |
|---|---|---|---|
| **ROBOT v1.9.x** (`robot.jar`) | Java 11+ | ELK, HermiT, Whelk, JFact, structural reasoners; consistency; unsatisfiable classes; QC report; diff; format conversion | De-facto OBO standard. Docker images: `obolibrary/robot` and `obolibrary/odkfull` |
| owlready2 0.51 + HermiT/Pellet | Python + Java | full OWL 2 DL: `sync_reasoner()`, `default_world.inconsistent_classes()` | Bundles the jars but still needs a JVM |
| Whelk | Scala/JVM | OWL EL (plus SWRL subset), very fast | Used inside ROBOT (`--reasoner whelk`) |
| horned-owl / py-horned-owl 2.0.0 | Rust/Python | parse and serialize OWL (OFN, OWX, RDF); **no reasoner** | Useful for fast parsing |
| whelk-rs | Rust | EL classification | Early-stage port |
| **eyereasoner** 21.x (EYE compiled to WASM SWI-Prolog) | **pure Node, no Java** | N3 rules; OWL 2 RL-style entailment through rule sets; can derive `owl:Nothing` and inconsistency flags | Not a DL reasoner |
| `@ontologos/wasm` / `ontologos` 1.1.4 | WASM / Node | Rust reasoner: EL, RL, RDFS, partial DL; `classify()`, `checkConsistency()` | New (2026). The first npm tarball was broken. Treat as experimental |

ROBOT commands:

```bash
robot reason --reasoner ELK --input onto.ttl --output reasoned.ttl     # fails non-zero if incoherent
robot reason -r HermiT -i onto.ttl --dump-unsatisfiable unsat.txt -o /dev/null
robot reason -r ELK -i onto.ttl --equivalent-classes-allowed asserted-only
robot report -i onto.ttl --fail-on ERROR -o report.tsv                 # QC: missing labels, dup defs…
robot diff --left v1.ttl --right v2.ttl --format markdown -o diff.md
robot convert -i onto.ttl -o onto.ofn                                  # needed for schemauto
```

From Node, run it with `execFile('java', ['-jar', 'robot.jar', 'reason', …])`. Parse exit codes, stderr and `unsat.txt`.

**Recommendation:** use a `Reasoner` interface with two backends.
1. **ROBOT (ELK by default, HermiT on demand)** whenever Java is available. Build the image with `eclipse-temurin:21-jre` plus `robot.jar`; it is the most trustworthy and also gives you `report` and `diff`.
2. **No-Java fallback: `eyereasoner`.** Run OWL-RL-style rules (subclass/disjointness/domain-range) to flag classes that entail `owl:Nothing` and disjointness clashes. Alternatively try `ontologos` for EL classification.

Label the fallback's results "lightweight check". It will miss DL-level unsatisfiability.

---

## 4. LinkML

- **OWL to LinkML:** schema-automator, `pip install schema-automator` (0.5.7). Docs: https://linkml.io/schema-automator/cli.html
  ```bash
  robot convert -i onto.ttl -o onto.ofn                      # import-owl requires OWL functional syntax
  schemauto import-owl onto.ofn -o schema.yaml -n MyOntology --model-uri https://example.org/onto/
  # RDFS-style Turtle directly:
  schemauto import-rdfs onto.ttl -f turtle -o schema.yaml -n MyOntology
  ```
  It works best on "schema-style" ontologies (classes plus properties with domain and range), and the conversion loses information on complex axioms.
- **LinkML to OWL and other formats:** `pip install linkml` (1.12.1).
  ```bash
  gen-owl schema.yaml -o schema.owl.ttl        # aka: linkml generate owl schema.yaml
  gen-shacl schema.yaml > shapes.ttl ; gen-json-schema schema.yaml > schema.json ; gen-doc schema.yaml -d docs/
  linkml-lint schema.yaml ; linkml-validate -s schema.yaml data.yaml
  ```
- **JS alternative:** there is no maintained JS or TypeScript LinkML toolchain; the generators and importers are Python-only. Options:
  - shell out to a Python sidecar (`uv run schemauto …`), or
  - write a small subset mapper yourself. Parse Turtle with `n3`, then map `owl:Class`, `rdfs:subClassOf`, and `owl:ObjectProperty`/`owl:DatatypeProperty` with domain and range to LinkML `classes`, `is_a` and `slots`, and dump with `yaml`. A prototype can do this in about 150 LOC, and you keep `schemauto` as the "high-fidelity" path.

---

## 5. MCP: TypeScript server SDK and client hookup

There are two release lines:
- **v1** (`@modelcontextprotocol/sdk` 1.32.1) is still `latest` on npm and is the most widely documented.
- **v2** is the split packages `@modelcontextprotocol/server`, `@modelcontextprotocol/node` and `@modelcontextprotocol/express`, which their README calls "the stable release line". It implements the 2026-07-28 spec. Migration guide: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2

**v2 (recommended for new code), stateless Streamable HTTP with Express:**

```ts
// npm i @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function buildServer() {
  const server = new McpServer({ name: 'ontology-platform', version: '0.1.0' });
  server.registerTool('add_class', {
    description: 'Propose a new OWL class in the working ontology',
    inputSchema: z.object({ iri: z.string(), label: z.string(), parent: z.string().optional() }),
  }, async ({ iri, label, parent }) => {
    await proposals.add({ iri, label, parent });
    return { content: [{ type: 'text', text: `Proposed ${label} <${iri}>` }] };
  });
  return server;
}

const app = createMcpExpressApp();            // applies Host/Origin guards + JSON parsing
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(3001);
```

**v1 equivalent:**
- Imports: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, and `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- `registerTool` takes `inputSchema` as a **raw zod shape** (`{ iri: z.string() }`), not `z.object(...)`.

**Auth:** for a prototype, check `Authorization: Bearer <platform token>` in Express middleware before `/mcp`. The SDKs also ship OAuth resource-server helpers.

**Clients:**
- Claude Code:
  ```bash
  claude mcp add --transport http ontology https://onto.example.org/mcp --header "Authorization: Bearer $TOKEN"
  # scope: --scope user|project (project writes .mcp.json); list: claude mcp list; in-session: /mcp
  ```
  The `.mcp.json` form is `{"mcpServers":{"ontology":{"type":"http","url":"https://…/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}`.
- Codex CLI (`@openai/codex` 0.162.x): `~/.codex/config.toml`
  ```toml
  [mcp_servers.ontology]
  url = "https://onto.example.org/mcp"
  bearer_token_env_var = "ONTO_TOKEN"
  # http_headers = { "X-Project" = "demo" }
  ```
  You can also run `codex mcp add ontology --url https://onto.example.org/mcp` (OAuth servers: `codex mcp login ontology`). Docs: https://learn.chatgpt.com/docs/extend/mcp?surface=cli

---

## 6. Browser speech-to-text for a voice feedback page

**Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`):**

| Browser | Support | Where the audio goes |
|---|---|---|
| Chrome (desktop and Android) | yes, prefixed `webkitSpeechRecognition` | Google cloud |
| Edge | yes on desktop; not on Edge Android/iOS | Azure |
| Safari 14.1+ (macOS) / 14.5+ (iOS) | yes | Apple, with a permission prompt |
| Firefox | **disabled by default** (about:config flag only) | n/a |

It needs HTTPS and a user gesture. Chrome continuous mode stops after silence, so restart it in `onend`. You get no access to the raw audio. Newer Chrome adds on-device recognition (`processLocally`) **(verify availability)**. Sources: https://www.testmuai.com/learning-hub/speech-recognition-api-browser-support/ and https://wiki.mozilla.org/Web_Speech_API_-_Speech_Recognition

**Recommended pattern:**
- Use Web Speech for live captions when it is available.
- **Always** also record with `MediaRecorder`: `audio/webm;codecs=opus` in Chrome and Firefox, `audio/mp4` in Safari; check `MediaRecorder.isTypeSupported`.
- Upload the recording to the server and transcribe it there. This gives you the authoritative text, plus Firefox support and an audio archive.
- Server STT options:
  - OpenAI `gpt-4o-transcribe` / `whisper-1` (`/v1/audio/transcriptions`)
  - Deepgram (also has WebSocket streaming)
  - AssemblyAI
  - Google Speech-to-Text
  - self-hosted `whisper.cpp` / `faster-whisper` in the container
- In-browser alternative: Whisper running in WASM/WebGPU with `@huggingface/transformers` (transformers.js). It is private but adds a large model download.

```js
const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4' });
rec.ondataavailable = e => chunks.push(e.data);
rec.onstop = () => fetch('/api/feedback/audio', { method: 'POST', body: new Blob(chunks, { type: rec.mimeType }) });
```

---

## 7. Federated login (Google + GitHub) for Node

- **Lucia is deprecated.** Since 2025 it has been a learning resource, and its author points people to **Arctic** (OAuth clients) plus **Oslo** (crypto helpers) with your own sessions.
- **Auth.js joined Better Auth** in September 2025. Auth.js (`next-auth` 4.24 / `@auth/*`) stays in maintenance mode, and new projects are steered to Better Auth. https://www.better-auth.com/blog/authjs-joins-better-auth

| Library | Fit |
|---|---|
| **better-auth 1.7.x** | Batteries included: social providers, sessions, DB adapters (SQLite/Postgres/Drizzle/Prisma) and an Express handler. Least code |
| **arctic 3.7.0** | Minimal, typed OAuth 2.0 clients for 60+ providers. You own the sessions and cookies. Best if you want full control (and Solid provisioning hooks) |
| `@auth/express` 0.12.x | Works, but it is in maintenance mode |
| passport 0.7 + `passport-google-oauth20` + `passport-github2` | Mature, callback-style, with express-session. Fine but dated |
| `openid-client` 6.x | Standards OIDC (Google). GitHub is OAuth2-only, not OIDC |

**Arctic example (the simplest thing that fully works):**

```ts
import { Google, GitHub, generateState, generateCodeVerifier } from 'arctic';
const google = new Google(GID, GSECRET, 'https://app/auth/google/callback');
const github = new GitHub(GHID, GHSECRET, 'https://app/auth/github/callback');

app.get('/auth/google', (req, res) => {
  const state = generateState(), verifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, verifier, ['openid', 'profile', 'email']);
  res.cookie('st', state, { httpOnly: true }).cookie('cv', verifier, { httpOnly: true }).redirect(url.toString());
});
app.get('/auth/google/callback', async (req, res) => {
  if (req.query.state !== req.cookies.st) return res.sendStatus(400);
  const tokens = await google.validateAuthorizationCode(String(req.query.code), req.cookies.cv);
  const claims = decodeIdToken(tokens.idToken()) as { sub: string; email: string; name: string }; // from 'arctic'
  const user = await upsertUser('google', claims.sub, claims);
  if (!user.webId) await provisionSolidPod(user);     // section 2
  setSessionCookie(res, user); res.redirect('/');
});
// GitHub: github.createAuthorizationURL(state, ['read:user','user:email']); validateAuthorizationCode(code);
// then fetch https://api.github.com/user with Bearer tokens.accessToken()
```

**Better Auth equivalent:**

```ts
betterAuth({ database, socialProviders: {
  google: { clientId, clientSecret },
  github: { clientId, clientSecret },
} })
```

Mount it with `app.all('/api/auth/*', toNodeHandler(auth))` and hook `databaseHooks.user.create.after` to provision the Solid pod.
