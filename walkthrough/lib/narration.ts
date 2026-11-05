/**
 * Parses narration.md, the human-editable script for the walkthrough video.
 *
 * Format (see the comment at the top of narration.md for the full guide):
 *
 *   ## Scene title {#scene-id requires=forks,jsClasses unless=x}
 *
 *   [do: action-name some args]     runs as the paragraph below starts, while it is spoken
 *   [then: action-name]             runs once the paragraph below has been spoken
 *   The paragraph that is spoken. One paragraph is one narration clip.
 *
 *   [pause: 1.5]                    a silent hold, in seconds
 *   [if: jsClasses,!forks]          keeps the paragraph below only when the hub has (or,
 *                                   with !, lacks) those features
 *
 * "{minutes}" in a paragraph becomes the estimated length of the recording, in words.
 *
 * Paragraphs with no [do:] keep the screen as it is. A [do:] with no paragraph after it
 * runs on its own, silently. HTML comments are notes for editors and are ignored.
 */

export interface Action {
  name: string;
  args: string[];
}

export interface Step {
  /** The words as written, for captions. Empty for a silent step. */
  text: string;
  /** Actions that run as the step starts, alongside the narration. */
  actions: Action[];
  /** Actions that run after the narration for this step has finished. */
  after: Action[];
  /**
   * Actions timed to a word: `{@action args}` inside the paragraph runs as the voice
   * reaches the word after it (from the voice's own timestamps where it gives them).
   * The mark is not spoken or captioned, so adding one never re-voices the paragraph.
   */
  marks: Mark[];
  /** Extra silent hold at the end of the step, in seconds. */
  pause: number;
  /** Features this step needs ("x") or must not have ("!x"). */
  when?: string[];
}

export interface Scene {
  id: string;
  title: string;
  /** Feature flags that must all be available for the scene to be recorded. */
  requires: string[];
  /** Feature flags that must all be missing (fallback scenes). */
  unless: string[];
  steps: Step[];
}

export interface Mark {
  /** Index of the word (in the paragraph's plain words) the action is timed to. */
  word: number;
  action: Action;
}

export interface Narration {
  meta: Record<string, string>;
  scenes: Scene[];
}

const HEADING = /^##\s+(.+?)\s*(?:\{([^}]*)\})?\s*$/;
const DIRECTIVE = /^\[(do|then|pause|if):\s*(.*?)\]\s*$/;

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseAttrs(raw: string | undefined) {
  const out: { id?: string; requires: string[]; unless: string[] } = { requires: [], unless: [] };
  for (const part of (raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('#')) out.id = part.slice(1);
    else {
      const [k, v = ''] = part.split('=');
      if (k === 'requires') out.requires.push(...v.split(',').filter(Boolean));
      else if (k === 'unless') out.unless.push(...v.split(',').filter(Boolean));
      else throw new Error(`Unknown scene attribute "${k}" (expected #id, requires= or unless=)`);
    }
  }
  return out;
}

function parseAction(raw: string): Action {
  const [name, ...args] = raw.trim().split(/\s+/);
  if (!name) throw new Error('Empty [do:] directive');
  return { name, args };
}

const MARK = /\{@([^}]*)\}/g;

/**
 * Takes the `{@action}` marks out of a paragraph. The text left is exactly what it would
 * be without them, so captions, speech and the voice cache are unaffected.
 */
export function extractMarks(raw: string): { text: string; marks: Mark[] } {
  const marks: Mark[] = [];
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(MARK)) {
    out += raw.slice(last, m.index);
    last = m.index! + m[0].length;
    const word = plain(out).split(/\s+/).filter(Boolean).length;
    marks.push({ word, action: parseAction(m[1]) });
  }
  out += raw.slice(last);
  const text = out.replace(/\s+/g, ' ').trim();
  const words = plain(text).split(/\s+/).filter(Boolean).length;
  for (const m of marks) if (m.word >= words) throw new Error(`A timing mark {@${m.action.name}} must come before a word: "${text.slice(0, 60)}"`);
  return { text, marks };
}

/**
 * When the voice reaches a word, in seconds from the clip's start: the voice's own
 * character timestamps where it gave them, otherwise an estimate from text length.
 */
export function wordTime(text: string, lexicon: Record<string, string>, duration: number, word: number, charStarts?: number[]) {
  const map = speechMap(text, lexicon);
  if (word >= map.words.length) return duration;
  const c = map.starts[word];
  return charStarts?.[c] ?? (c / (map.speech.length || 1)) * duration;
}

export function parseNarration(source: string): Narration {
  const meta: Record<string, string> = {};
  let body = source.replace(/\r\n/g, '\n');
  const front = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (front) {
    for (const line of front[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    body = body.slice(front[0].length);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '');

  const scenes: Scene[] = [];
  let scene: Scene | undefined;
  let pending: { actions: Action[]; after: Action[]; when?: string[] } = { actions: [], after: [] };
  let para: string[] = [];

  const flushPara = () => {
    if (!scene) {
      if (para.length) throw new Error(`Narration before the first "## Scene" heading: "${para.join(' ').slice(0, 60)}"`);
      return;
    }
    const { text, marks } = extractMarks(para.join(' '));
    para = [];
    if (!text && !pending.actions.length && !pending.after.length) return;
    scene.steps.push({ text, actions: pending.actions, after: pending.after, marks, pause: 0, ...(pending.when ? { when: pending.when } : {}) });
    pending = { actions: [], after: [] };
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const h = line.match(HEADING);
    if (h) {
      flushPara();
      const attrs = parseAttrs(h[2]);
      scene = { id: attrs.id ?? slug(h[1]), title: h[1].trim(), requires: attrs.requires, unless: attrs.unless, steps: [] };
      if (scenes.some((s) => s.id === scene!.id)) throw new Error(`Duplicate scene id "${scene.id}"`);
      scenes.push(scene);
      continue;
    }
    if (line.startsWith('# ')) continue; // the document title
    const d = line.match(DIRECTIVE);
    if (d) {
      // A directive after some text ends that paragraph.
      if (para.length) flushPara();
      if (!scene) throw new Error(`[${d[1]}:] before the first "## Scene" heading`);
      if (d[1] === 'pause') {
        const secs = Number(d[2]);
        if (!Number.isFinite(secs) || secs < 0) throw new Error(`Bad pause "${d[2]}"`);
        if (pending.actions.length || pending.after.length) flushPara();
        const last = scene.steps.at(-1);
        if (last) last.pause += secs;
        else scene.steps.push({ text: '', actions: [], after: [], marks: [], pause: secs });
      } else if (d[1] === 'if') {
        const when = d[2].split(',').map((x) => x.trim()).filter(Boolean);
        if (!when.length) throw new Error('Empty [if:] directive');
        pending.when = [...(pending.when ?? []), ...when];
      } else if (d[1] === 'do') {
        pending.actions.push(parseAction(d[2]));
      } else {
        pending.after.push(parseAction(d[2]));
      }
      continue;
    }
    if (!line) {
      if (para.length) flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  // A trailing [do:] block with no paragraph becomes a silent step.
  if (scene && (pending.actions.length || pending.after.length)) scene.steps.push({ text: '', actions: pending.actions, after: pending.after, marks: [], pause: 0 });

  return { meta, scenes };
}

/** Strips light Markdown (emphasis, code, links) so captions and speech read cleanly. */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .trim();
}

/**
 * Applies the pronunciation lexicon to the text sent to the voice. Keys are matched as
 * whole words, case-sensitively, longest first, so "SHACLC" wins over "SHACL".
 */
export function forSpeech(text: string, lexicon: Record<string, string>): string {
  let out = plain(text);
  const keys = Object.keys(lexicon).sort((a, b) => b.length - a.length);
  if (!keys.length) return out;
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w-])(${keys.map(esc).join('|')})(?![\\w-])`, 'g');
  out = out.replace(re, (m) => lexicon[m] ?? m);
  return out;
}

/**
 * The text sent to the voice, built word by word from the caption text so that each
 * caption word's position in the spoken text is known (for timing captions from the
 * voice's character timestamps).
 */
export function speechMap(text: string, lexicon: Record<string, string>): { speech: string; words: string[]; starts: number[] } {
  const words = plain(text).split(/\s+/).filter(Boolean);
  const starts: number[] = [];
  let speech = '';
  for (const w of words) {
    if (speech) speech += ' ';
    starts.push(speech.length);
    speech += forSpeech(w, lexicon);
  }
  return { speech, words, starts };
}

/**
 * Readable caption phrases: one per sentence, and a long sentence split into balanced
 * pieces under `max` characters, at a comma near the middle where there is one.
 */
export function phrases(text: string, max = 84): { text: string; firstWord: number }[] {
  const words = plain(text).split(/\s+/).filter(Boolean);
  const out: { text: string; firstWord: number }[] = [];
  const len = (from: number, to: number) => words.slice(from, to).join(' ').length;
  const split = (from: number, to: number) => {
    if (len(from, to) <= max || to - from < 2) {
      out.push({ text: words.slice(from, to).join(' '), firstWord: from });
      return;
    }
    // Break where the two halves are closest in length; a comma break wins if it's not too lopsided.
    let best = from + 1;
    let bestScore = Infinity;
    for (let k = from + 1; k < to; k++) {
      const imbalance = Math.abs(len(from, k) - len(k, to));
      const score = /[,;:]$/.test(words[k - 1]) ? imbalance - max / 3 : imbalance;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    split(from, best);
    split(best, to);
  };
  let start = 0;
  words.forEach((w, i) => {
    if (/[.!?]["')\]]*$/.test(w)) {
      split(start, i + 1);
      start = i + 1;
    }
  });
  if (start < words.length) split(start, words.length);
  return out;
}

/** Caption cues for one clip, in seconds from the clip's start. */
export function cuesFor(text: string, lexicon: Record<string, string>, duration: number, charStarts?: number[]) {
  const ps = phrases(text);
  const at = (wordIndex: number) => wordTime(text, lexicon, duration, wordIndex, charStarts);
  return ps.map((p, i) => ({ start: at(p.firstWord), end: i + 1 < ps.length ? at(ps[i + 1].firstWord) : duration, text: p.text }));
}

/** Splits a paragraph into sentences for caption cues. */
export function sentences(text: string): string[] {
  const parts = plain(text).match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function selectScenes(n: Narration, features: Set<string>, only?: string[]) {
  const kept: Scene[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const s of n.scenes) {
    if (only?.length && !only.includes(s.id)) continue;
    const missing = s.requires.filter((f) => !features.has(f));
    const present = s.unless.filter((f) => features.has(f));
    if (missing.length) skipped.push({ id: s.id, reason: `needs ${missing.join(', ')}` });
    else if (present.length) skipped.push({ id: s.id, reason: `fallback not needed (${present.join(', ')} available)` });
    else kept.push({ ...s, steps: s.steps.filter((st) => (st.when ?? []).every((w) => (w.startsWith('!') ? !features.has(w.slice(1)) : features.has(w)))) });
  }
  return { kept, skipped };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];

/**
 * Fills "{minutes}" in the selected scenes with the expected length of the video, as a
 * word ("nine"), so the intro states the length of what is actually recorded. The
 * estimate is speech at 155 words a minute plus 10% for actions that outlast it, which
 * matched a measured recording to within ten seconds.
 */
export function fillMinutes(scenes: Scene[]): number {
  const words = scenes.flatMap((s) => s.steps).reduce((n, st) => n + st.text.split(/\s+/).filter(Boolean).length, 0);
  const minutes = Math.max(1, Math.round((words / 155) * 1.1));
  for (const st of scenes.flatMap((s) => s.steps)) st.text = st.text.replace(/\{minutes\}/g, NUMBER_WORDS[minutes] ?? String(minutes));
  return minutes;
}
