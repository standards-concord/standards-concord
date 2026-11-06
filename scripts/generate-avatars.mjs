#!/usr/bin/env node
/**
 * Generates the profile pictures for the demo's simulated people and alpha testers.
 *
 *   pnpm avatars
 *
 * The pictures are DiceBear "Notionists" avatars (artwork by Zoish, CC0 1.0), rendered
 * once and committed under apps/web/public/avatars so the demo works offline and never
 * asks a third-party service for an image. Output is deterministic: rerunning the script
 * rewrites the same files.
 *
 * - avatars/personas/<key>.svg: one per simulated working-group member (PERSONAS in
 *   apps/server/src/services/personas.ts). The seeds below were picked by eye from a
 *   contact sheet; change one to give that person a different look.
 * - avatars/demo/NN.svg: a pool for alpha testers' demo accounts, which the server hands
 *   out by a hash of the account id (demoAvatarUrl in apps/server/src/services/avatars.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAvatar } from '@dicebear/core';
import * as notionists from '@dicebear/notionists';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/web/public/avatars');

/** Keep in step with DEMO_AVATAR_COUNT in apps/server/src/services/avatars.ts. */
const DEMO_AVATAR_COUNT = 24;

const PERSONA_SEEDS = {
  priya: 'Priya Shah#4',
  tom: 'Tom Okafor#7',
  aisha: 'Aisha Rahman#12',
  gareth: 'Gareth Lewis#14',
  mei: 'Mei Chen#4',
  daniel: 'Daniel Brooks#8',
};

// No hand gestures or shirt logos: they turn to noise at the 18–32px sizes the app uses.
// The background stays transparent so the Avatar component's per-name colour shows through.
const options = { gestureProbability: 0, bodyIconProbability: 0 };
const render = (seed) => createAvatar(notionists, { seed, ...options }).toString() + '\n';

function write(rel, svg) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg);
}

for (const [key, seed] of Object.entries(PERSONA_SEEDS)) write(`personas/${key}.svg`, render(seed));
for (let i = 0; i < DEMO_AVATAR_COUNT; i++) write(`demo/${String(i).padStart(2, '0')}.svg`, render(`concord-demo-${i}`));

console.log(`Wrote ${Object.keys(PERSONA_SEEDS).length} persona and ${DEMO_AVATAR_COUNT} demo avatars to ${path.relative(root, out)}`);
