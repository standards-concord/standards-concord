/**
 * Records the narrated Concord walkthrough video.
 *
 *   pnpm walkthrough                       voice from the environment, records everything
 *   pnpm walkthrough --voice elevenlabs    pick a voice provider (asks for the key if unset)
 *   pnpm walkthrough --draft               silent narration (captions only), fast
 *   pnpm walkthrough --only intro,goals    just some scenes
 *   pnpm walkthrough --strict              fail on any UI drift (a missing button etc.)
 *   pnpm walkthrough --check               run every step quickly with no video or voice (CI)
 *   pnpm walkthrough --help
 *
 * Output goes to walkthrough/out/: concord-walkthrough.mp4 (1080p, AAC, soft captions),
 * .vtt captions, chapters.txt (YouTube-style) and report.json.
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Route } from '@playwright/test';
import { Capture } from './lib/capture.ts';
import { Director, sleep } from './lib/director.ts';
import { McpClient } from './lib/mcp.ts';
import { mux, type Placed } from './lib/mux.ts';
import { forSpeech, parseNarration, selectScenes, type Action, type Scene } from './lib/narration.ts';
import { fill, startConcord, startStatic } from './lib/servers.ts';
import { Terminal } from './lib/terminal.ts';
import { askHidden, autoProvider, DEFAULTS, needsKey, Voice, type ProviderName } from './lib/tts.ts';
import { actions, type Ctx } from './scenes.ts';
import { vendorModule } from './lib/vendor.ts';

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
    out: { type: 'string', default: path.join(HERE, 'out') },
    narration: { type: 'string', default: path.join(HERE, 'narration.md') },
    web: { type: 'string', default: 'dev' },
    hub: { type: 'string' },
    'shown-hub': { type: 'string', default: 'https://standards-concord.vercel.app' },
    features: { type: 'string' },
    'no-shims': { type: 'boolean' },
    'list-actions': { type: 'boolean' },
    'voice-only': { type: 'boolean' },
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

const log = (s: string) => console.log(s);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function main() {
  const narration = parseNarration(await readFile(argv.narration!, 'utf8'));
  const lexicon = Object.fromEntries(Object.entries(JSON.parse(await readFile(path.join(HERE, 'lexicon.json'), 'utf8')) as Record<string, string>).filter(([k]) => !k.startsWith('_')));

  // Every action named in the script must exist, before we spend anything on voices.
  const unknown = narration.scenes.flatMap((s) => s.steps.flatMap((st) => [...st.actions, ...st.after]).filter((a) => !actions[a.name]).map((a) => `${s.id}: ${a.name}`));
  if (unknown.length) throw new Error(`narration.md uses actions that scenes.ts doesn't define:\n  ${unknown.join('\n  ')}`);

  const provider = (argv.draft || argv.check ? 'silent' : (argv.voice as ProviderName | undefined) ?? autoProvider()) as ProviderName;
  if (!DEFAULTS[provider]) throw new Error(`Unknown voice provider "${provider}". Use elevenlabs, openai, google, say or silent.`);
  const key = needsKey(provider);
  if (key && !process.env[key]) process.env[key] = await askHidden(`${key} (input hidden): `);
  const voice = new Voice({ provider, voice: argv['voice-id'], model: argv.model, rate: argv.rate ? Number(argv.rate) : undefined }, path.join(HERE, '.cache', 'voice'));
  log(`Voice: ${voice.label}`);

  await mkdir(argv.out!, { recursive: true });

  // 1. Boot Concord (unless recording an existing hub) and find out what it can do.
  const concord = argv.hub ? undefined : await (log('Starting Concord…'), startConcord({ apiPort: 8798, webPort: 5184, mode: argv.web === 'preview' ? 'preview' : 'dev' }));
  const hub = (argv.hub ?? concord!.web).replace(/\/$/, '');
  const shownHub = argv['shown-hub']!.replace(/\/$/, '');
  try {
    const browser = await chromium.launch({ headless: !argv.headed, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: 'light', reducedMotion: 'no-preference', locale: 'en-GB', timezoneId: 'Europe/London' });
    await context.addInitScript({ path: path.join(HERE, 'stage', 'overlay.js') });
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

    const { kept, skipped } = selectScenes(narration, features, argv.only?.split(','));
    for (const s of skipped) log(`  skip ${s.id}: ${s.reason}`);
    if (!kept.length) throw new Error('No scenes to record');

    // 2. Voice every paragraph (cached), with its neighbours for natural flow.
    const steps = kept.flatMap((s) => s.steps.map((st) => ({ scene: s, step: st })));
    const spoken = steps.filter((x) => x.step.text);
    const clips = new Map<object, { file: string; duration: number }>();
    if (!argv.check) {
      log(`Voicing ${spoken.length} paragraphs…`);
      let fresh = 0;
      await pool(spoken, 3, async (x, i) => {
        const c = await voice.synth({ text: forSpeech(x.step.text, lexicon), previous: spoken[i - 1] && forSpeech(spoken[i - 1].step.text, lexicon), next: spoken[i + 1] && forSpeech(spoken[i + 1].step.text, lexicon) });
        if (!c.cached) fresh++;
        clips.set(x.step, c);
      });
      const speech = [...clips.values()].reduce((a, c) => a + c.duration, 0);
      log(`  ${fresh} new, ${spoken.length - fresh} cached, ${fmt(speech)} of speech`);
    }
    if (argv['voice-only']) return;

    // 3. The sample app's working copy, served with the stage pages.
    const appDir = path.join(argv.out!, 'helping-hands');
    await rm(appDir, { recursive: true, force: true });
    await cp(path.join(HERE, 'sample-app', 'base'), appDir, { recursive: true });
    const mainClasses = `${shownHub}/def/${ontology.slug}.js`;
    const appJs = path.join(appDir, 'app.js');
    await writeFile(appJs, fill(await readFile(appJs, 'utf8'), { CLASSES: mainClasses, HUB: shownHub }));
    const stat = await startStatic({ port: 4417, appDir: () => appDir, stageDir: path.join(HERE, 'stage'), vars: () => ({ HUB: shownHub }) });

    const shown = (text: string) => local.reduce((t, l) => t.split(l).join(shownHub), text);
    const shims = new Set<string>();
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
    };

    // 4. Record: each paragraph starts its actions and its narration together, and the
    //    next paragraph waits for both. The narration is laid on afterwards at the same times.
    await page.goto(`${stat.url}/__stage/blank.html`);
    const video = path.join(argv.out!, 'video.mp4');
    const cap = new Capture(page, video, { fps: 30, width: 1920, height: 1080, quality: 92, crf: 18 });
    if (argv.check) {
      // Run every step back to back, without recording or waiting for narration.
      for (const scene of kept) {
        log(`▶ ${scene.id}`);
        for (const step of scene.steps) {
          await run(ctx, scene, step.actions);
          await run(ctx, scene, step.after);
        }
      }
      stat.close();
      await browser.close();
      await writeFile(path.join(argv.out!, 'report.json'), JSON.stringify({ check: true, hub, features: [...features], scenes: kept.map((s) => s.id), skipped, shims: [...shims], warnings: d.warnings }, null, 2));
      log(`\nChecked ${kept.length} scenes: ${d.warnings.length ? `${d.warnings.length} warning(s)` : 'all steps worked'}.`);
      if (d.warnings.length) process.exitCode = 1;
      return;
    }
    await cap.start();
    const placed: Placed[] = [];
    const chapters: { at: number; title: string }[] = [];
    const LEAD = 0.35;
    const GAP = 0.45;
    for (const scene of kept) {
      log(`▶ ${scene.id}`);
      chapters.push({ at: cap.now(), title: scene.title });
      for (const step of scene.steps) {
        const clip = clips.get(step);
        const start = cap.now();
        if (clip) placed.push({ file: clip.file, at: start + LEAD, duration: clip.duration, text: step.text });
        const speaking = clip ? sleep((LEAD + clip.duration) * 1000) : Promise.resolve();
        await Promise.all([run(ctx, scene, step.actions), speaking]);
        await run(ctx, scene, step.after);
        await sleep((GAP + step.pause) * 1000);
      }
    }
    await sleep(1500);
    const seconds = await cap.stop();
    stat.close();
    await browser.close();

    // 5. Mix the narration in, with captions and chapters.
    log('Mixing…');
    const out = path.join(argv.out!, 'concord-walkthrough.mp4');
    await mux({ video, videoSeconds: seconds, clips: placed, out, captions: path.join(argv.out!, 'concord-walkthrough.vtt'), chapters, title: narration.meta.title });
    await rm(video, { force: true });
    await writeFile(path.join(argv.out!, 'chapters.txt'), chapters.map((c) => `${fmt(c.at)} ${c.title}`).join('\n') + '\n');
    const report = {
      recordedAt: new Date().toISOString(),
      duration: Math.round(seconds),
      voice: voice.label,
      hub,
      features: [...features],
      scenes: kept.map((s) => s.id),
      skipped,
      shims: [...shims],
      warnings: d.warnings,
    };
    await writeFile(path.join(argv.out!, 'report.json'), JSON.stringify(report, null, 2));
    log(`\nDone: ${out} (${fmt(seconds)})`);
    if (shims.size) log(`\n⚠ Stand-ins were used for platform features this hub doesn't serve yet:\n  ${[...shims].join('\n  ')}\n  Re-record once they're deployed, or pass --no-shims to refuse.`);
    if (d.warnings.length) log(`\n${d.warnings.length} warning(s); see report.json.`);
  } finally {
    concord?.stop();
  }
}

/**
 * Runs in every page: shows the public hub address wherever the local one appears in the
 * page's text (the hub prints its own URL in places), and hides the alpha testers'
 * floating "Walkthrough" button, which would sit in the corner of every shot.
 */
function presentation({ local, shown }: { local: string[]; shown: string }) {
  const fix = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue ?? '';
      if (local.some((l) => t.includes(l))) n.nodeValue = local.reduce((acc, l) => acc.split(l).join(shown), t);
    }
    for (const b of (root instanceof Element || root instanceof Document ? root : document).querySelectorAll?.('button.fixed') ?? []) {
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
        const r = await route.fetch({ url: `${base}${u.pathname}${u.search}` });
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

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).stack ?? e}`);
  process.exit(1);
});
