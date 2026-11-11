/**
 * walkthrough.yml must keep paid narration when a recording fails. The first full run
 * voiced the tour (about 5,800 ElevenLabs characters), then failed on a missing font;
 * the narration was only packed and cached after a successful recording, so all of it
 * was lost and had to be paid for again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/walkthrough.yml'), 'utf8');
/** The text of each step in the record job, from its `- ` to the next one. */
const steps = yml
  .slice(yml.indexOf('\n  record:'), yml.indexOf('\n  attach:'))
  .split(/\n      - /)
  .slice(1);
const step = (match: RegExp) => steps.find((s) => match.test(s)) ?? '';

describe('the recording workflow', () => {
  it('packs and caches the narration even when recording fails', () => {
    const record = steps.findIndex((s) => /name: Record\b/.test(s));
    const pack = steps.findIndex((s) => /tar -czf walkthrough\/out\/walkthrough-voice\.tar\.gz/.test(s));
    const save = steps.findIndex((s) => /uses: actions\/cache\/save@/.test(s) && /walkthrough\/\.cache\/voice/.test(s));
    expect(record).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(record);
    expect(save).toBeGreaterThan(record);
    for (const i of [pack, save]) expect(steps[i]).toMatch(/if: always\(\)/);
  });

  it('saves each run’s narration under its own key and restores the newest', () => {
    expect(step(/actions\/cache\/save@/)).toMatch(/key: walkthrough-voice-.*\$\{\{ github\.run_id \}\}/);
    expect(step(/actions\/cache\/restore@/)).toMatch(/restore-keys:/);
    expect(steps.some((s) => /uses: actions\/cache@/.test(s) && /\.cache\/voice/.test(s))).toBe(false);
  });

  // The features video (features.md) isn't on /welcome, and attach-release.sh needs everything
  // the page plays (the two videos and the clips), so release runs record exactly that, and
  // only a run that recorded all of it is ever attached.
  it('records and attaches the tour, the feedback video and the clips for a release', () => {
    expect(step(/name: Record\b/)).toMatch(/VIDEO: \$\{\{ inputs\.video \|\| 'tour,feedback,clips' \}\}/);
    expect(step(/name: Record\b/)).toMatch(/--video "\$VIDEO"/);
    const attach = yml.slice(yml.indexOf('\n  attach:'));
    expect(attach).toMatch(/inputs\.video == 'tour,feedback,clips'/);
    expect(attach).not.toMatch(/inputs\.video == 'tour,feedback'\)/);
  });

  it('keeps the clips’ playlist in the artifact the attach job uploads', () => {
    expect(step(/actions\/upload-artifact@/)).toMatch(/walkthrough\/out\/concord-clips\.json/);
  });

  it('keys the narration cache on every script, the features video’s and the clips’ included', () => {
    for (const s of [step(/actions\/cache\/restore@/), step(/actions\/cache\/save@/)]) for (const f of [/walkthrough\/features\.md/, /walkthrough\/clips\.md/]) expect(s).toMatch(f);
  });

  // The features video is only recorded on demand, so its narration (about 3,600 characters)
  // was kept only in that run's artifact, and the next features run would have paid for all
  // of it again. seed_voice_run reuses it, through seed-voice.sh (test/seed-voice.test.ts).
  it('can reuse narration kept in an earlier run’s artifact, after the release’s and before recording', () => {
    const restore = steps.findIndex((s) => /name: Restore narration from the last release/.test(s));
    const seed = steps.findIndex((s) => /name: Seed narration from an earlier run/.test(s));
    const record = steps.findIndex((s) => /name: Record\b/.test(s));
    expect(restore).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(restore);
    expect(seed).toBeLessThan(record);
    const s = steps[seed];
    expect(yml).toMatch(/\n {6}seed_voice_run:\n/);
    expect(s).toMatch(/if: .*inputs\.seed_voice_run != ''/);
    expect(s).toMatch(/RUN: \$\{\{ inputs\.seed_voice_run \}\}/);
    expect(s).toMatch(/REPO: \$\{\{ github\.repository \}\}/);
    // The checked script is what runs, given that same variable; nothing is unpacked here.
    expect(s).toMatch(/run: bash walkthrough\/seed-voice\.sh "\$RUN" walkthrough\/\.cache\/voice\s*$/);
    const job = yml.slice(yml.indexOf('\n  record:'), yml.indexOf('\n    steps:', yml.indexOf('\n  record:')));
    expect(job).toMatch(/\n {6}actions: read\n/);
    expect(job).not.toMatch(/: write\b/);
  });

  // The repository was re-created with no releases, so the restore found no narration and the
  // next recording would have re-voiced every paragraph (about 12,000 characters) even though
  // the media repository's release kept all of it. It now falls back to that repository.
  it('restores narration from this repository’s releases first, then from the media repository’s', () => {
    const s = step(/name: Restore narration from the last release/);
    expect(s).toMatch(/REPO: \$\{\{ github\.repository \}\}/);
    expect(s).toMatch(/MEDIA_REPO: \$\{\{ vars\.MEDIA_REPO \|\| 'standards-concord\/concord-media' \}\}/);
    expect(s).toMatch(/for repo in "\$REPO" "\$MEDIA_REPO"; do/);
    expect(s).toMatch(/gh release download "\$t" --repo "\$repo" --pattern walkthrough-voice\.tar\.gz/);
  });

  // An archive is only ever unpacked by unpack-voice.sh, which refuses links and odd paths.
  it('unpacks narration archives only through unpack-voice.sh', () => {
    expect(step(/name: Restore narration from the last release/)).toMatch(/bash walkthrough\/unpack-voice\.sh "\$RUNNER_TEMP\/walkthrough-voice\.tar\.gz" walkthrough\/\.cache\/voice/);
    for (const s of steps) expect(s).not.toMatch(/tar (-\w*x|--extract)/);
  });

  // Inputs and other expressions reach scripts only through env, so no value can become shell code.
  it('never pastes an expression into a script', () => {
    const runs = [...yml.matchAll(/\n( +)run: (\|[^\n]*\n(?:\1 +[^\n]*\n|\s*\n)*|[^\n]*)/g)].map((m) => m[2]);
    expect(runs.length).toBeGreaterThan(5);
    for (const r of runs) expect(r).not.toMatch(/\$\{\{/);
  });
});
