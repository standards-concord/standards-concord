import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineDiff } from '../lib/terminal.ts';
import { vtt } from '../lib/mux.ts';
import { forSpeech, parseNarration, selectScenes, sentences } from '../lib/narration.ts';
import { actions } from '../scenes.ts';

describe('narration parser', () => {
  const doc = `---
title: Test
---
<!-- editor notes are ignored -->
# Title

## First scene {#one}

[do: open-hub]
Hello there. This is the first paragraph,
spread over two lines.

[then: clear-highlight]
Second paragraph, cleared once spoken.

[pause: 1.5]

## Second {#two requires=forks unless=shaclc}

[do: open-app]
[do: show-app-code]
`;

  it('splits scenes, paragraphs and directives', () => {
    const n = parseNarration(doc);
    expect(n.meta.title).toBe('Test');
    expect(n.scenes.map((s) => s.id)).toEqual(['one', 'two']);
    const [a, b] = n.scenes;
    expect(a.steps).toHaveLength(2);
    expect(a.steps[0]).toMatchObject({ text: 'Hello there. This is the first paragraph, spread over two lines.', actions: [{ name: 'open-hub', args: [] }] });
    expect(a.steps[1]).toMatchObject({ text: 'Second paragraph, cleared once spoken.', actions: [], after: [{ name: 'clear-highlight', args: [] }], pause: 1.5 });
    expect(b.requires).toEqual(['forks']);
    expect(b.unless).toEqual(['shaclc']);
    // Actions with no paragraph become one silent step.
    expect(b.steps).toEqual([{ text: '', actions: [{ name: 'open-app', args: [] }, { name: 'show-app-code', args: [] }], after: [], pause: 0 }]);
  });

  it('keeps a paragraph with no directive as narration over the current screen', () => {
    const n = parseNarration('## S {#s}\n\n[do: open-hub]\nSpoken.\n\nNext.');
    expect(n.scenes[0].steps.map((s) => [s.text, s.actions.length])).toEqual([
      ['Spoken.', 1],
      ['Next.', 0],
    ]);
  });

  it('rejects narration outside a scene and duplicate ids', () => {
    expect(() => parseNarration('Orphan words.\n\n## S\n')).toThrow(/before the first/);
    expect(() => parseNarration('## A {#x}\n\n## B {#x}\n')).toThrow(/Duplicate/);
  });

  it('selects scenes by available features', () => {
    const n = parseNarration(doc);
    expect(selectScenes(n, new Set()).kept.map((s) => s.id)).toEqual(['one']);
    expect(selectScenes(n, new Set(['forks'])).kept.map((s) => s.id)).toEqual(['one', 'two']);
    expect(selectScenes(n, new Set(['forks', 'shaclc'])).kept.map((s) => s.id)).toEqual(['one']);
  });

  it('applies the lexicon to whole words, longest first', () => {
    const lex = { SHACL: 'shackle', SHACLC: 'shackle compact', ODI: 'O D I' };
    expect(forSpeech('SHACL and SHACLC from the ODI, not ODIs. Use `SHACL`.', lex)).toBe('shackle and shackle compact from the O D I, not ODIs. Use shackle.');
  });

  it('splits sentences for captions', () => {
    expect(sentences("It's here. Really? Yes!")).toEqual(["It's here.", 'Really?', 'Yes!']);
  });
});

describe('the real script', () => {
  const n = parseNarration(readFileSync(path.join(import.meta.dirname, '..', 'narration.md'), 'utf8'));

  it('only uses actions that scenes.ts defines', () => {
    const used = n.scenes.flatMap((s) => s.steps.flatMap((st) => [...st.actions, ...st.after].map((a) => a.name)));
    expect(used.filter((a) => !actions[a])).toEqual([]);
  });

  it('has narration in every scene', () => {
    for (const s of n.scenes) expect(s.steps.some((st) => st.text), s.id).toBe(true);
  });
});

describe('helpers', () => {
  it('diffs lines with context', () => {
    const rows = lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng', 1);
    expect(rows).toEqual([
      { t: 'ctx', n: 3, s: 'c' },
      { t: 'del', n: 4, s: 'd' },
      { t: 'add', n: 4, s: 'D' },
      { t: 'ctx', n: 5, s: 'e' },
    ]);
  });

  it('writes one caption cue per sentence', () => {
    const out = vtt([{ file: 'x', at: 1, duration: 4, text: 'One two. Six six.' }]);
    expect(out).toContain('00:00:01.000 --> 00:00:03.000\nOne two.');
    expect(out).toContain('00:00:03.000 --> 00:00:05.000\nSix six.');
  });
});
