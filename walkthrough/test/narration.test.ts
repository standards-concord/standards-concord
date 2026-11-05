import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineDiff } from '../lib/terminal.ts';
import { vtt } from '../lib/mux.ts';
import { cuesFor, extractMarks, fillMinutes, forSpeech, parseNarration, phrases, selectScenes, sentences, speechMap, wordTime } from '../lib/narration.ts';
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
    expect(b.steps).toEqual([{ text: '', actions: [{ name: 'open-app', args: [] }, { name: 'show-app-code', args: [] }], after: [], marks: [], pause: 0 }]);
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

describe.each(['narration.md', 'feedback.md'])('the real script %s', (file) => {
  const n = parseNarration(readFileSync(path.join(import.meta.dirname, '..', file), 'utf8'));

  it('only uses actions that scenes.ts defines', () => {
    const used = n.scenes.flatMap((s) => s.steps.flatMap((st) => [...st.actions, ...st.after, ...st.marks.map((m) => m.action)].map((a) => a.name)));
    expect(used.filter((a) => !actions[a])).toEqual([]);
  });

  it('has narration in every scene', () => {
    for (const s of n.scenes) expect(s.steps.some((st) => st.text), s.id).toBe(true);
  });

  it('never speaks or captions a timing mark', () => {
    for (const s of n.scenes) for (const st of s.steps) expect(st.text).not.toMatch(/\{@/);
  });
});

describe('timing marks', () => {
  it('leaves the words exactly as they would be without the marks', () => {
    // The voice cache is keyed by the words, so a mark must never change them.
    const plainText = 'Next, press Go to open the page, and tick each task off.';
    const marked = extractMarks('Next, {@point-go} press Go to open the page, and {@tick a b} tick each task off.');
    expect(marked.text).toBe(plainText);
    expect(speechMap(marked.text, {}).speech).toBe(speechMap(plainText, {}).speech);
    expect(marked.marks).toEqual([
      { word: 1, action: { name: 'point-go', args: [] } },
      { word: 8, action: { name: 'tick', args: ['a', 'b'] } },
    ]);
    expect(speechMap(marked.text, {}).words[8]).toBe('tick');
  });

  it('counts words in the text as shown, after Markdown is stripped', () => {
    const m = extractMarks('Open **the Classes view** and {@x} press [Go](https://example.org) now.');
    expect(plainWords(m.text)[m.marks[0].word]).toBe('press');
  });

  it('refuses a mark with no word after it', () => {
    expect(() => extractMarks('Press Submit. {@submit}')).toThrow(/must come before a word/);
  });

  it('parses marks into steps alongside [do:] actions', () => {
    const n = parseNarration('## One {#one}\n\n[do: open]\nFirst words, then {@click-it} click it.\n');
    expect(n.scenes[0].steps[0]).toMatchObject({ text: 'First words, then click it.', actions: [{ name: 'open' }], marks: [{ word: 3, action: { name: 'click-it' } }] });
  });

  it('times a mark from the voice’s own character timestamps', () => {
    // "Say SHACLC now": the lexicon respells SHACLC, so the word starts are speech offsets.
    const text = 'Say SHACLC now';
    const lexicon = { SHACLC: 'shackle see' };
    const speech = speechMap(text, lexicon).speech;
    const charStarts = [...speech].map((_, i) => i * 0.1);
    expect(wordTime(text, lexicon, 3, 2, charStarts)).toBeCloseTo(speech.indexOf('now') * 0.1);
    // Without timestamps, an estimate from the share of characters.
    expect(wordTime(text, lexicon, 3, 2)).toBeCloseTo((speech.indexOf('now') / speech.length) * 3);
    expect(wordTime(text, lexicon, 3, 9)).toBe(3);
  });
});

const plainWords = (t: string) => speechMap(t, {}).words;

describe('conditional paragraphs', () => {
  const doc = `## Intro {#intro}

[do: open-hub]
[if: jsClasses]
Long tour with the developer story.

[do: open-hub]
[if: !jsClasses]
Short tour.

Always said.
`;
  it('keeps only the paragraphs whose features match', () => {
    const n = parseNarration(doc);
    const withClasses = selectScenes(n, new Set(['jsClasses'])).kept[0].steps.map((s) => s.text);
    const without = selectScenes(n, new Set()).kept[0].steps.map((s) => s.text);
    expect(withClasses).toEqual(['Long tour with the developer story.', 'Always said.']);
    expect(without).toEqual(['Short tour.', 'Always said.']);
  });
});

describe('spoken length', () => {
  it('fills {minutes} from the words in the selected scenes', () => {
    const words = Array.from({ length: 560 }, () => 'word').join(' ');
    const n = parseNarration(`## A {#a}\n\nIn about {minutes} minutes.\n\n${words}\n`);
    const kept = selectScenes(n, new Set()).kept;
    expect(fillMinutes(kept)).toBe(4);
    expect(kept[0].steps[0].text).toBe('In about four minutes.');
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

  it('writes the caption cues it is given, offset by the clip start', () => {
    const cues = [
      { start: 0, end: 2, text: 'One two.' },
      { start: 2, end: 4, text: 'Six six.' },
    ];
    const out = vtt([{ file: 'x', at: 1, duration: 4, text: 'One two. Six six.', cues }]);
    expect(out).toContain('00:00:01.000 --> 00:00:03.000\nOne two.');
    expect(out).toContain('00:00:03.000 --> 00:00:05.000\nSix six.');
  });
});

describe('captions', () => {
  it('keeps cues short, preferring a comma break', () => {
    const long = 'Concord keeps every proposal, vote and release in one place, so a standards group can work without long meetings and still see who decided what.';
    const ps = phrases(long, 84);
    expect(ps.length).toBeGreaterThan(1);
    for (const p of ps) expect(p.text.length).toBeLessThanOrEqual(84);
    expect(ps[0].text.endsWith(',')).toBe(true);
    expect(ps.map((p) => p.text).join(' ')).toBe(long);
  });

  it('splits long sentences into balanced pieces, without orphan words', () => {
    const ps = phrases('This is Helping Hands, a small web app that lists volunteering opportunities near you.', 60);
    expect(ps.length).toBe(2);
    for (const p of ps) expect(p.text.length).toBeGreaterThan(20);
  });

  it('never lets a short cue overlap the next one', () => {
    const out = vtt([{ file: 'x', at: 0, duration: 1, text: 'A. B.', cues: [{ start: 0, end: 0.1, text: 'A.' }, { start: 0.2, end: 1, text: 'B.' }] }]);
    expect(out).toContain('00:00:00.000 --> 00:00:00.200\nA.');
  });

  it('maps caption words onto the spoken text after the lexicon', () => {
    const m = speechMap('Write SHACL shapes.', { SHACL: 'shackle' });
    expect(m.speech).toBe('Write shackle shapes.');
    expect(m.starts).toEqual([0, 6, 14]);
  });

  it('times cues from the voice’s character timestamps when given', () => {
    const text = 'Hello there. Bye now.';
    const speech = speechMap(text, {}).speech;
    // Pretend the voice paused for a long time before "Bye".
    const starts = [...speech].map((_, i) => (i < 13 ? i * 0.1 : 5 + (i - 13) * 0.1));
    const cues = cuesFor(text, {}, 6, starts);
    expect(cues).toEqual([
      { start: 0, end: 5, text: 'Hello there.' },
      { start: 5, end: 6, text: 'Bye now.' },
    ]);
  });
});
