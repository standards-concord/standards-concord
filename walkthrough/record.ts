/**
 * Records the narrated Concord videos: the platform tour (narration.md) and, for alpha
 * testers, how to take part and give feedback (feedback.md).
 *
 *   pnpm walkthrough                       voice from the environment, records both videos
 *   pnpm walkthrough --video feedback      just one of them (tour or feedback)
 *   pnpm walkthrough --voice elevenlabs    pick a voice provider (asks for the key if unset)
 *   pnpm walkthrough --draft               silent narration (captions only), fast
 *   pnpm walkthrough --only intro,goals    just some scenes
 *   pnpm walkthrough --strict              fail on any UI drift (a missing button etc.)
 *   pnpm walkthrough --check               run every step quickly with no video or voice (CI)
 *   pnpm walkthrough --publish             a release video: strict, no stand-ins, no outside
 *                                          requests, and it fails rather than produce a flawed video
 *   pnpm walkthrough --help
 *
 * Output goes to walkthrough/out/, per video (concord-walkthrough, concord-feedback):
 * <name>.mp4 (1080p, AAC, soft captions), .vtt captions, .transcript.md, .chapters.txt
 * (YouTube-style) and .report.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Route } from '@playwright/test';
import { Capture } from './lib/capture.ts';
import { Director, sleep } from './lib/director.ts';
import { guardContext, launchBrowser } from './lib/browser.ts';
import { McpClient } from './lib/mcp.ts';
import { mux, type Placed } from './lib/mux.ts';
import { cuesFor, fillMinutes, parseNarration, plain, selectScenes, speechMap, wordTime, type Action, type Scene } from './lib/narration.ts';
import { fill, startConcord, startStatic } from './lib/servers.ts';
import { Terminal } from './lib/terminal.ts';
import { askHidden, autoProvider, DEFAULTS, needsKey, Voice, type ProviderName } from './lib/tts.ts';
import { actions, type Ctx } from './scenes.ts';
import { vendorModule } from './lib/vendor.ts';
import { serveFonts } from './lib/fonts.ts';
import { startEgressProxy, type Egress } from './lib/egress.ts';
import { applyRunBudget, parseBudget, recordVideos, videoEnv } from './lib/budget.ts';

const HERE = import.meta.dirname;
const ALL_FEATURES = ['forks', 'jsClasses', 'shaclc', 'appChecks', 'connectPage'];

const { values: argv } = parseArgs({
  options: {
    voice: { type: 'string' },
    'voice-id': { type: 'string' },
    model: { type: 'string' },
    rate: { type: 'string' },
    draft: { type: 'boolean' },
    check: { type: 'boolean' },
    only: { type: 'string' },
    strict: { type: 'boolean' },
    publish: { type: 'boolean' },
    out: { type: 'string', default: path.join(HERE, 'out') },
    video: { type: 'string', default: 'all' },
    narration: { type: 'string' },
    web: { type: 'string', default: 'dev' },
    hub: { type: 'string' },
    'shown-hub': { type: 'string', default: 'https://standards-concord.vercel.app' },
    features: { type: 'string' },
    'no-shims': { type: 'boolean' },
    'list-actions': { type: 'boolean' },
    'voice-only': { type: 'boolean' },
    'voice-budget': { type: 'string' },
    'voice-plan': { type: 'string' },
    headed: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (argv.help) {
  console.log(readFileSync(path.join(HERE, 'README.md'), 'utf8'));
  process.exit(0);
}
if (argv['list-actions']) {
  console.log(Object.keys(actions).sort().join('\n'));
  process.exit(0);
}

/** Most characters a paid voice may be sent in this run, across all its videos (lib/budget.ts). */
const VOICE_BUDGET = parseBudget(argv['voice-budget'] ?? process.env.VOICE_CHAR_BUDGET);

// A release video must be exactly what the script claims, or nothing at all.
if (argv.publish) {
  argv.strict = true;
  argv['no-shims'] = true;
  if (argv.draft || argv.check) throw new Error('--publish records the real thing: drop --draft/--check');
}

/**
 * Pages loaded through the egress proxy or fulfilled by a Playwright route lose
 * Chromium's record that they came from localhost, so its local-network checks would
 * then block the dev server's own websocket. Everything here is local (and the proxy
 * enforces that), so turn those checks off.
 */

/** "Now", as far as the recorded hub and browser are concerned, so dates on screen never drift. */
const EPOCH = '2026-11-23T10:00:00Z';

const log = (s: string) => console.log(s);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The videos this script makes, recorded in this order (the feedback video's landing page shows the tour). */
const VIDEOS: Record<string, { script: string; name: string }> = {
  tour: { script: 'narration.md', name: 'concord-walkthrough' },
  feedback: { script: 'feedback.md', name: 'concord-feedback' },
};

/** Which video(s) to make: --narration names a script directly; --only picks the video that has those scenes. */
async function pickVideos(): Promise<string[]> {
  if (argv.narration) return ['custom'];
  if (argv.video !== 'all') {
    if (!VIDEOS[argv.video!]) throw new Error(`Unknown video "${argv.video}". Use ${Object.keys(VIDEOS).join(', ')} or all.`);
    return [argv.video!];
  }
  if (!argv.only) return Object.keys(VIDEOS);
  const ids = argv.only.split(',');
  const found: string[] = [];
  for (const [k, v] of Object.entries(VIDEOS)) {
    const n = parseNarration(await readFile(path.join(HERE, v.script), 'utf8'));
    if (n.scenes.some((sc) => ids.includes(sc.id))) found.push(k);
  }
  if (!found.length) throw new Error(`No video has scenes ${argv.only}`);
  return found;
}

async function portsFree(ports: number[], ms = 20_000) {
  const { connect } = await import('node:net');
  const busy = (port: number) =>
    new Promise<boolean>((r) => {
      const sock = connect(port, '127.0.0.1');
      sock.on('connect', () => (sock.destroy(), r(true))).on('error', () => r(false));
    });
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!(await Promise.all(ports.map(busy))).some(Boolean)) return;
    await sleep(300);
  }
  throw new Error(`Ports ${ports.join(', ')} are still in use`);
}

/** Records several videos one after another, each in a fresh process with a fresh Concord. */
async function recordEach(videos: string[]) {
  // Ask for a missing key once, here, rather than once per video.
  const provider = (argv.draft || argv.check ? 'silent' : (argv.voice as ProviderName | undefined) ?? autoProvider()) as ProviderName;
  const key = DEFAULTS[provider] ? needsKey(provider) : undefined;
  if (key && !process.env[key]) process.env[key] = await askHidden(`${key} (input hidden): `);
  const { spawn } = await import('node:child_process');
  const passOn = process.argv.slice(2).filter((a, i, all) => a !== '--video' && all[i - 1] !== '--video' && !a.startsWith('--video='));
  const child = async (v: string, extra: string[], env: NodeJS.ProcessEnv) => {
    await portsFree([8798, 5184, 4417]);
    return new Promise<number>((r) => spawn(process.execPath, [...process.execArgv, process.argv[1], ...passOn, ...extra, '--video', v], { stdio: 'inherit', env }).on('exit', (c) => r(c ?? 1)));
  };
  await recordVideos({
    videos,
    paid: ['elevenlabs', 'openai', 'google'].includes(provider),
    budget: VOICE_BUDGET,
    log,
    quota: async (total) => {
      const q = await new Voice({ provider }, path.join(HERE, '.cache', 'voice')).checkQuota(total);
      if (q) log(`ElevenLabs usage: ${q.used.toLocaleString('en')} of ${q.limit.toLocaleString('en')} characters this period, enough for this run`);
    },
    plan: async (v, file) => {
      if ((await child(v, ['--voice-plan', file], process.env)) !== 0) throw new Error(`Planning the ${v} video failed`);
    },
    record: async (v, ledger) => {
      if ((await child(v, [], videoEnv(process.env, ledger))) !== 0) throw new Error(`Recording the ${v} video failed`);
    },
  });
}

async function main() {
  const videos = await pickVideos();
  if (videos.length > 1) return recordEach(videos);
  const video = videos[0] === 'custom' ? { script: argv.narration!, name: 'concord-walkthrough' } : VIDEOS[videos[0]];
  const name = video.name;
  const outFile = (suffix: string) => path.join(argv.out!, `${name}${suffix}`);
  const narration = parseNarration(await readFile(path.resolve(HERE, video.script), 'utf8'));
  const lexicon = Object.fromEntries(Object.entries(JSON.parse(await readFile(path.join(HERE, 'lexicon.json'), 'utf8')) as Record<string, string>).filter(([k]) => !k.startsWith('_')));

  // Every action named in the script must exist, before we spend anything on voices.
  const unknown = narration.scenes.flatMap((s) => s.steps.flatMap((st) => [...st.actions, ...st.after]).filter((a) => !actions[a.name]).map((a) => `${s.id}: ${a.name}`));
  if (unknown.length) throw new Error(`narration.md uses actions that scenes.ts doesn't define:\n  ${unknown.join('\n  ')}`);

  const provider = (argv.draft || argv.check ? 'silent' : (argv.voice as ProviderName | undefined) ?? autoProvider()) as ProviderName;
  if (!DEFAULTS[provider]) throw new Error(`Unknown voice provider "${provider}". Use elevenlabs, openai, google, say or silent.`);
  if (argv.publish && (provider === 'silent' || provider === 'say')) throw new Error(`--publish needs a narration voice (elevenlabs, openai or google), not "${provider}"`);
  const key = needsKey(provider);
  if (key && !process.env[key]) process.env[key] = await askHidden(`${key} (input hidden): `);
  const voice = new Voice({ provider, voice: argv['voice-id'], model: argv.model, rate: argv.rate ? Number(argv.rate) : undefined }, path.join(HERE, '.cache', 'voice'));
  // Recording several videos: what the others sent counts against the same budget.
  applyRunBudget(voice, process.env, VOICE_BUDGET);
  log(`Voice: ${voice.label}`);

  await mkdir(argv.out!, { recursive: true });

  // 1. Boot Concord (unless recording an existing hub) and find out what it can do.
  const concord = argv.hub ? undefined : await (log('Starting Concord…'), startConcord({ apiPort: 8798, webPort: 5184, mode: argv.web === 'preview' ? 'preview' : 'dev', epoch: EPOCH, env: { MEDIA_DIR: path.resolve(argv.out!) } }));
  const hub = (argv.hub ?? concord!.web).replace(/\/$/, '');
  let egress: Egress | undefined;
  const shownHub = argv['shown-hub']!.replace(/\/$/, '');
  try {
    // Every connection the browser makes goes through the allowlisting proxy, loopback included.
    const outside = new Set<string>();
    egress = await startEgressProxy([hub, concord?.api].filter(Boolean) as string[], outside);
    const browser = await launchBrowser({ proxy: egress.url, headless: !argv.headed, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'] });
    const chromiumVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: 'light', reducedMotion: 'no-preference', locale: 'en-GB', timezoneId: 'Europe/London' });
    // tsx compiles with keepNames, which wraps functions we hand to the page in __name().
    await context.addInitScript('globalThis.__name ??= (f) => f;');
    await guardContext(context);
    await context.addInitScript({ path: path.join(HERE, 'stage', 'overlay.js') });
    // The browser's clock agrees with the server's, and runs normally from there.
    if (!argv.hub) await context.clock.setSystemTime(new Date(EPOCH));
    const page = await context.newPage();
    const api = page.request;
    const local = [hub, concord?.api].filter(Boolean) as string[];
    await context.addInitScript(presentation, { local, shown: shownHub });

    // A demo account for "me", the developer in the story, and an MCP token for Claude Code.
    await api.get(`${hub}/api/personas`);
    const signIn = await api.post(`${hub}/api/auth/demo`, { data: { name: 'Sam Taylor', role: 'reviewer' } });
    if (!signIn.ok()) throw new Error(`Demo sign-in failed (${signIn.status()}): is DEMO_MODE on for ${hub}?`);
    const ontologies = (await (await api.get(`${hub}/api/ontologies`)).json()) as { id: string; slug: string; title: string; demo?: boolean }[];
    const ontology = ontologies.find((x) => x.slug === 'volunteering') ?? ontologies.find((x) => x.demo) ?? ontologies[0];
    if (!ontology) throw new Error('No ontologies on the hub');
    const tok = await api.post(`${hub}/api/agent-tokens`, { data: { name: 'Claude Code' } });
    if (!tok.ok()) throw new Error(`Creating an MCP token failed: ${tok.status()}`);
    const token = ((await tok.json()) as { token: string }).token;
    const mcp = new McpClient(`${hub}/mcp`, token);
    await mcp.connect();

    const features = await detectFeatures(hub, mcp, ontology.id);
    log(`Platform features: ${[...features].join(', ') || 'none of the optional ones'}`);
    // For drafts only: let the app scenes run on a stand-in for the generated classes,
    // clearly labelled on screen. Published videos (--no-shims) skip those scenes instead.
    const classesStandIn = !features.has('jsClasses') && !argv['no-shims'];
    if (classesStandIn) {
      // Scenes that show the hub's own Classes pages still skip (unless=jsClassesStandIn).
      features.add('jsClasses').add('jsClassesStandIn');
      log('  generated JS classes: not on this hub; the draft uses a labelled stand-in');
    }

    const { kept, skipped } = selectScenes(narration, features, argv.only?.split(','));
    for (const s of skipped) log(`  skip ${s.id}: ${s.reason}`);
    if (!kept.length) throw new Error('No scenes to record');
    const promisesLength = kept.some((s) => s.steps.some((st) => st.text.includes('{minutes}')));
    const promisedMinutes = fillMinutes(kept);
    if (promisesLength) log(`  the intro will say about ${promisedMinutes} minutes`);

    // 2. Voice every paragraph (cached), with its neighbours for natural flow.
    const steps = kept.flatMap((s) => s.steps.map((st) => ({ scene: s, step: st })));
    const spoken = steps.filter((x) => x.step.text);
    const clips = new Map<object, { file: string; duration: number; charStarts?: number[] }>();
    const say = (text: string) => speechMap(text, lexicon).speech;
    if (!argv.check) {
      const reqs = spoken.map((x, i) => ({ text: say(x.step.text), previous: spoken[i - 1] && say(spoken[i - 1].step.text), next: spoken[i + 1] && say(spoken[i + 1].step.text) }));
      // Paid voices have limited characters: refuse up front rather than run out halfway.
      if (argv['voice-plan']) {
        await writeFile(argv['voice-plan'], JSON.stringify({ cost: voice.cost(reqs) }));
        return;
      }
      const cost = voice.checkBudget(reqs);
      // And the account itself must have that many characters left.
      const quota = await voice.checkQuota(cost);
      if (quota) log(`ElevenLabs usage: ${quota.used.toLocaleString('en')} of ${quota.limit.toLocaleString('en')} characters this period${quota.resetsAt ? ` (resets ${quota.resetsAt.slice(0, 10)})` : ''}`);
      else if (cost && provider === 'elevenlabs') log('ElevenLabs usage: not readable with this key; the run budget still applies');
      log(`Voicing ${spoken.length} paragraphs${voice.paid ? ` (${cost.toLocaleString('en')} new characters${voice.budget ? ` of a ${voice.budget.toLocaleString('en')} budget${voice.spent ? `, ${voice.spent.toLocaleString('en')} already sent` : ''}` : ''})` : ''}…`);
      let fresh = 0;
      await pool(spoken, 3, async (x, i) => {
        const c = await voice.synth(reqs[i]);
        if (!c.cached) fresh++;
        clips.set(x.step, c);
      });
      const speech = [...clips.values()].reduce((a, c) => a + c.duration, 0);
      log(`  ${fresh} new, ${spoken.length - fresh} cached, ${fmt(speech)} of speech`);
      if (fresh && provider === 'elevenlabs') {
        const after = await voice.quota();
        if (after) log(`  ElevenLabs usage now: ${after.used.toLocaleString('en')} of ${after.limit.toLocaleString('en')} characters`);
      }
    }
    if (argv['voice-only']) return;

    // 3. The sample app's working copy, served with the stage pages.
    const appDir = outFile('-helping-hands');
    await rm(appDir, { recursive: true, force: true });
    await cp(path.join(HERE, 'sample-app', 'base'), appDir, { recursive: true });
    const mainClasses = `${shownHub}/def/${ontology.slug}.js`;
    const appJs = path.join(appDir, 'app.js');
    await writeFile(appJs, fill(await readFile(appJs, 'utf8'), { CLASSES: mainClasses, HUB: shownHub }));
    const stat = await startStatic({ port: 4417, appDir: () => appDir, stageDir: path.join(HERE, 'stage'), vars: () => ({ HUB: shownHub }) });

    const shown = (text: string) => local.reduce((t, l) => t.split(l).join(shownHub), text);
    const shims = new Set<string>();
    egress.allow(stat.url);
    // Registered after the guard, so it answers font requests first (Playwright runs the newest route first).
    const fonts = { fetched: new Set<string>(), missing: new Set<string>() };
    await serveFonts(context, { dir: path.join(HERE, 'fonts'), offline: !!argv.publish, ...fonts });
    await routeModules(page, { hub, api: concord?.api, shownHub, noShims: !!argv['no-shims'], shims });

    // Warm up: compile pages in the dev server and fill caches so nothing loads on camera.
    log('Warming up…');
    for (const p of ['/', `/o/${ontology.id}`, `/o/${ontology.id}/browse`, `/o/${ontology.id}/source`, `/o/${ontology.id}/query`, `/o/${ontology.id}/changes`, `/o/${ontology.id}/governance`]) await page.goto(`${hub}${p}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.goto(stat.url, { waitUntil: 'networkidle' }).catch(() => {});

    const d = new Director(page, !!argv.strict);
    const ctx: Ctx = {
      d,
      term: new Terminal(d, `${stat.url}/__stage/terminal.html`),
      mcp,
      api,
      hub,
      shownHub,
      ontology: { id: ontology.id, slug: ontology.slug ?? 'volunteering', title: ontology.title },
      features,
      app: { url: `${stat.url}/`, dir: appDir, sampleDir: path.join(HERE, 'sample-app'), classes: mainClasses },
      shown,
      state: { token },
      notices: { classesStandIn, publishing: !!argv.publish },
    };

    // 4. Record: each paragraph starts its actions and its narration together, and the
    //    next paragraph waits for both. The narration is laid on afterwards at the same times.
    await page.goto(`${stat.url}/__stage/blank.html`);
    const raw = outFile('.raw.mp4');
    const cap = new Capture(page, raw, { fps: 30, width: 1920, height: 1080, quality: 92, crf: 18 });
    if (argv.check) {
      // Run every step back to back, without recording or waiting for narration.
      for (const scene of kept) {
        log(`▶ ${scene.id}`);
        for (const step of scene.steps) {
          await run(ctx, scene, step.actions);
          await run(ctx, scene, step.marks.map((m) => m.action));
          await run(ctx, scene, step.after);
        }
      }
      stat.close();
      await browser.close();
      await writeFile(outFile('.report.json'), JSON.stringify({ check: true, video: name, hub, features: [...features], scenes: kept.map((s) => s.id), skipped, shims: [...shims], outsideRequests: [...outside], fontsFetchedLive: [...fonts.fetched], warnings: d.warnings }, null, 2));
      if (fonts.fetched.size) log(`\n⚠ ${fonts.fetched.size} web font file(s) weren't in walkthrough/fonts/ and were fetched live. Commit them so recordings stay offline.`);
      log(`\nChecked ${kept.length} scenes: ${d.warnings.length ? `${d.warnings.length} warning(s)` : 'all steps worked'}.`);
      if (outside.size) log(`\n⚠ Blocked requests to outside hosts:\n  ${[...outside].join('\n  ')}`);
      if (d.warnings.length || (argv.strict && outside.size)) process.exitCode = 1;
      return;
    }
    await cap.start();
    const placed: Placed[] = [];
    const chapters: { at: number; title: string }[] = [];
    const LEAD = 0.35;
    const GAP = 0.45;
    /** How late a timed mark may run before the recording counts it as out of sync. */
    const MAX_LATE = 0.75;
    const sync: { scene: string; action: string; word: string; at: number; late: number }[] = [];
    for (const scene of kept) {
      log(`▶ ${scene.id}`);
      chapters.push({ at: cap.now(), title: scene.title });
      for (const step of scene.steps) {
        cap.check();
        const clip = clips.get(step);
        const start = cap.now();
        if (clip) placed.push({ file: clip.file, at: start + LEAD, duration: clip.duration, text: step.text, cues: cuesFor(step.text, lexicon, clip.duration, clip.charStarts) });
        const speaking = clip ? sleep((LEAD + clip.duration) * 1000) : Promise.resolve();
        const opening = run(ctx, scene, step.actions);
        // Timed marks wait for the step's opening actions, then for their word.
        const marked = (async () => {
          await opening;
          for (const m of step.marks) {
            const due = clip ? start + LEAD + wordTime(step.text, lexicon, clip.duration, m.word, clip.charStarts) : cap.now();
            if (due > cap.now()) await sleep((due - cap.now()) * 1000);
            const late = cap.now() - due;
            sync.push({ scene: scene.id, action: m.action.name, word: plain(step.text).split(/\s+/)[m.word], at: Number(due.toFixed(2)), late: Number(late.toFixed(2)) });
            if (late > MAX_LATE) d.warnings.push(`${scene.id} / {@${m.action.name}} ran ${late.toFixed(1)}s after its word; move the mark later or shorten what runs before it`);
            await run(ctx, scene, [m.action]);
          }
        })();
        await Promise.all([opening, marked, speaking]);
        await run(ctx, scene, step.after);
        await sleep((GAP + step.pause) * 1000);
      }
    }
    await sleep(1500);
    const seconds = await cap.stop();
    // The intro says how long the video is; check it said the truth.
    if (promisesLength && Math.abs(seconds / 60 - promisedMinutes) > 1.5)
      d.note(`The intro promises about ${promisedMinutes} minutes, but the video is ${fmt(seconds)}`);
    // A big backlog means the encoder couldn't keep up. Timing stays right (frames are counted),
    // but the machine is close to running out of memory, so it's worth knowing.
    if (cap.peakBacklogBytes > 256 * 1024 * 1024) d.warnings.push(`video encoder fell behind (peak backlog ${Math.round(cap.peakBacklogBytes / 1048576)} MB); use a faster machine`);
    stat.close();
    await browser.close();

    // 5. Mix the narration in, with captions and chapters.
    log('Mixing…');
    const out = outFile('.mp4');
    await mux({ video: raw, videoSeconds: seconds, clips: placed, out, captions: outFile('.vtt'), chapters, title: narration.meta.title });
    await rm(raw, { force: true });
    await writeFile(outFile('.chapters.txt'), chapters.map((c) => `${fmt(c.at)} ${c.title}`).join('\n') + '\n');
    // A clean transcript of exactly the scenes in this video.
    await writeFile(
      outFile('.transcript.md'),
      `# ${narration.meta.title ?? 'Concord walkthrough'}\n\n` + kept.map((s, i) => `## ${s.title} (${fmt(chapters[i].at)})\n\n${s.steps.filter((st) => st.text).map((st) => plain(st.text)).join('\n\n')}`).join('\n\n') + '\n',
    );
    const report = {
      recordedAt: new Date().toISOString(),
      duration: Math.round(seconds),
      voice: voice.label,
      hub,
      features: [...features],
      scenes: kept.map((s) => s.id),
      skipped,
      shims: [...shims],
      outsideRequests: [...outside],
      fontsFetchedLive: [...fonts.fetched],
      fontsMissing: [...fonts.missing],
      promisedMinutes: promisesLength ? promisedMinutes : undefined,
      toolchain: await toolchain(chromiumVersion),
      // Timed marks: when each was due in the video, and how late its action started.
      sync,
      frameLatency: cap.latency(),
      warnings: d.warnings,
      captionTiming: clips.size && [...clips.values()].every((c) => c.charStarts) ? 'voice timestamps' : 'estimated from text length',
    };
    await writeFile(outFile('.report.json'), JSON.stringify(report, null, 2));
    if (argv.publish && (d.warnings.length || shims.size || outside.size || fonts.missing.size)) {
      throw new Error(`Not publishable: ${d.warnings.length} warning(s), ${shims.size} stand-in(s), ${outside.size} outside request(s), ${fonts.missing.size} missing font file(s). See report.json.`);
    }
    // Some warnings arrive between steps (page errors, failed requests), so strict mode checks again at the end.
    if (argv.strict && (d.warnings.length || outside.size)) throw new Error(`--strict: ${d.warnings.length} warning(s) and ${outside.size} blocked outside request(s) during the recording. See report.json.`);
    log(`\nDone: ${out} (${fmt(seconds)})`);
    if (outside.size) log(`\n⚠ Blocked requests to outside hosts:\n  ${[...outside].join('\n  ')}`);
    if (shims.size) log(`\n⚠ Stand-ins were used for platform features this hub doesn't serve yet:\n  ${[...shims].join('\n  ')}\n  Re-record once they're deployed, or pass --no-shims to refuse.`);
    if (d.warnings.length) log(`\n${d.warnings.length} warning(s); see report.json.`);
  } finally {
    concord?.stop();
    await egress?.close();
  }
}

/**
 * Runs in every page: shows the public hub address wherever the local one appears in the
 * page's text (the hub prints its own URL in places), and hides the alpha testers'
 * floating "Walkthrough" button, which would sit in the corner of every shot.
 *
 * CodeMirror owns its DOM and redraws any text changed under it, which would set this
 * observer off again forever, so code views are changed through the editor instead.
 */
function presentation({ local, shown }: { local: string[]; shown: string }) {
  const swap = (t: string) => local.reduce((acc, l) => acc.split(l).join(shown), t);
  const editor = (content: Element) => {
    // EditorView.findFromDOM, without importing the app's CodeMirror.
    const tile = (content as any).cmTile ?? (content as any).cmView;
    const view = tile?.root?.view ?? tile?.rootView?.view;
    if (!view) return;
    const doc: string = view.state.doc.toString();
    if (!local.some((l) => doc.includes(l))) return;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: swap(doc) } });
  };
  const fix = (root: Node) => {
    const el = root instanceof Element ? root : root.parentElement;
    const inEditor = el?.closest('.cm-content');
    if (inEditor) return editor(inEditor);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('.cm-editor') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue ?? '';
      if (local.some((l) => t.includes(l))) n.nodeValue = swap(t);
    }
    const scope = root instanceof Element || root instanceof Document ? root : document;
    for (const c of scope.querySelectorAll?.('.cm-content') ?? []) editor(c);
    for (const b of scope.querySelectorAll?.('button.fixed') ?? []) {
      if (/^\s*Walkthrough/.test(b.textContent ?? '')) (b as HTMLElement).style.display = 'none';
    }
  };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') fix(m.target.parentNode ?? m.target);
      for (const n of m.addedNodes) fix(n.nodeType === Node.TEXT_NODE ? (n.parentNode ?? n) : n);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

async function run(ctx: Ctx, scene: Scene, list: Action[]) {
  for (const a of list) {
    try {
      await actions[a.name](ctx, ...a.args);
    } catch (e) {
      if (argv.strict) throw new Error(`${scene.id} / ${a.name}: ${(e as Error).message}`);
      ctx.d.warnings.push(`${scene.id} / ${a.name}: ${(e as Error).message.split('\n')[0]}`);
      console.warn(`  ! ${scene.id} / ${a.name} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

/** Which optional platform features this hub has, so scenes can depend on them. */
async function detectFeatures(hub: string, mcp: McpClient, ontologyId: string): Promise<Set<string>> {
  const f = new Set<string>();
  if (argv.features) {
    for (const x of argv.features.split(',')) if (x) f.add(x.replace(/^-/, ''));
    for (const x of argv.features.split(',')) if (x.startsWith('-')) f.delete(x.slice(1));
    if (!argv.features.split(',').some((x) => x === 'auto')) return f;
    f.delete('auto');
  }
  const ok = async (url: string, init?: RequestInit, test?: (r: Response) => boolean | Promise<boolean>) => {
    try {
      const r = await fetch(url, init);
      return test ? await test(r) : r.ok;
    } catch {
      return false;
    }
  };
  if (mcp.tools.includes('create_fork')) f.add('forks');
  if (await ok(`${hub}/def/volunteering/draft.js`, undefined, (r) => r.ok && /javascript/.test(r.headers.get('content-type') ?? ''))) f.add('jsClasses');
  // Unknown formats fall back to Turtle, so look for SHACLC's own syntax.
  if (await ok(`${hub}/api/ontologies/${ontologyId}/source?format=shaclc`, undefined, async (r) => r.ok && /^\s*shape\s/m.test(await r.text()))) f.add('shaclc');
  if (await ok(`${hub}/api/app-checks/pending`, undefined, (r) => r.status !== 404)) f.add('appChecks');
  if (await ok(`${hub}/.well-known/oauth-protected-resource`, undefined, (r) => r.ok && /json/.test(r.headers.get('content-type') ?? ''))) f.add('connectPage');
  for (const x of (argv.features ?? '').split(',')) if (x.startsWith('-')) f.delete(x.slice(1));
  return f;
}

/**
 * Recordings shouldn't depend on the outside world: anything not served by the hub
 * being recorded, the stage server, or a route below is blocked and reported. The app's
 * web fonts are the one exception, so the video shows the real typography.
 */
/**
 * Network routing for the recording:
 * - CDN modules (n3, @rdfjs/wrapper) are served from local bundles, so recordings work
 *   offline and never change because a CDN did.
 * - The public hub URL shown in the app's code is served by the hub being recorded.
 * - If that hub can't serve generated JS classes yet, a stand-in with the same shape is
 *   served instead (and reported), unless --no-shims.
 */
async function routeModules(page: import('@playwright/test').Page, o: { hub: string; api?: string; shownHub: string; noShims: boolean; shims: Set<string> }) {
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(n3|@rdfjs\/wrapper)@[^/]+\/\+esm$/, async (route: Route) => {
    const name = route.request().url().includes('/n3@') ? 'n3' : '@rdfjs/wrapper';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: await vendorModule(name), headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(`${o.shownHub}/**`, async (route: Route) => {
    const u = new URL(route.request().url());
    for (const base of [o.hub, o.api].filter(Boolean) as string[]) {
      try {
        // Redirects are not followed: this fetch runs outside the browser and its proxy.
        const r = await route.fetch({ url: `${base}${u.pathname}${u.search}`, maxRedirects: 0 });
        if (r.ok() && /javascript/.test(r.headers()['content-type'] ?? '')) {
          const body = (await r.text()).split(o.hub).join(o.shownHub);
          return route.fulfill({ status: 200, contentType: 'text/javascript', body, headers: { 'access-control-allow-origin': '*' } });
        }
      } catch {
        /* try the next */
      }
    }
    if (u.pathname.startsWith('/def/') && u.pathname.endsWith('.js') && !o.noShims) {
      // The story's new class exists in forks and in versions released after it; not in the original.
      const hasActivity = u.pathname.includes('/forks/') || /\/\d+\.\d+\.\d+\.js$/.test(u.pathname);
      o.shims.add(`generated JS classes (${u.pathname})`);
      let src = await readFile(path.join(HERE, 'sample-app', 'fallback', 'volunteering.js'), 'utf8');
      if (!hasActivity) src = src.replace(/\s*\/\* @activity-start \*\/[\s\S]*?\/\* @activity-end \*\//g, '');
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: src, headers: { 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });
}

/** Versions of everything that affects the pixels and the sound, for comparing recordings. */
async function toolchain(chromiumVersion: string) {
  const { execFile } = await import('node:child_process');
  const os = await import('node:os');
  const out = (cmd: string, args: string[]) => new Promise<string>((r) => execFile(cmd, args, (_e, stdout) => r(String(stdout ?? '').split('\n')[0].trim())));
  const distro = existsSync('/etc/os-release') ? (await readFile('/etc/os-release', 'utf8')).match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1] : process.platform === 'darwin' ? `macOS ${await out('sw_vers', ['-productVersion'])}` : undefined;
  return { node: process.version, chromium: chromiumVersion, ffmpeg: await out('ffmpeg', ['-version']), os: [distro, `${os.type()} ${os.release()} ${os.arch()}`].filter(Boolean).join(' · ') };
}

// Exits rather than waiting for stray handles (an early return, such as --voice-plan,
// leaves the browser open).
main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(`\n✗ ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
