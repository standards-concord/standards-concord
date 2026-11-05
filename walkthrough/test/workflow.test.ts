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
});
