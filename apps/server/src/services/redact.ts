import type { ChangeOp } from '@concord/core/types';
import type { UseCase } from '@concord/shared';
import { getUser } from './users.js';

/**
 * Keeps use case titles and contributor names out of the ontology, which is
 * published (the public page, every download, GitHub) while use cases may be
 * private. Used wherever drafted edits come from use cases: synthesis, and AI
 * revisions of the change requests it opens.
 */
export interface Secrets {
  titles: RegExp | undefined;
  people: RegExp | undefined;
  /** Multi-word titles, compared whole against term labels. */
  titleLabels: Set<string>;
}

const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** One case-insensitive, whole-word pattern for any of the values, tolerant of spacing differences. */
function pattern(values: (string | undefined)[]): RegExp | undefined {
  const words = [...new Set(values.map((v) => v?.normalize('NFKC').trim()).filter((v): v is string => !!v && v.length >= 2))].sort((a, b) => b.length - a.length);
  if (!words.length) return undefined;
  const alt = words.map((w) => w.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
}

export function secretsFor(useCases: UseCase[]): Secrets {
  const titles = useCases.map((u) => u.sections.name);
  return {
    titles: pattern(titles),
    people: pattern(useCases.map((u) => getUser(u.authorId)?.name)),
    titleLabels: new Set(titles.filter((t): t is string => !!t && /\S\s+\S/.test(t.trim())).map(norm)),
  };
}

const test = (re: RegExp | undefined, text: string) => !!re && new RegExp(re.source, re.flags.replace('g', '')).test(text.normalize('NFKC'));

/** Text with titles replaced by "a use case" and names by "a participant". */
export function redactText(text: string, s: Secrets): string;
export function redactText(text: string | undefined, s: Secrets): string | undefined;
export function redactText(text: string | undefined, s: Secrets): string | undefined {
  if (text === undefined) return text;
  let out = text.normalize('NFKC');
  if (s.titles) out = out.replace(s.titles, 'a use case');
  if (s.people) out = out.replace(s.people, 'a participant');
  return out;
}

/** Would this name or label publish a title or a person? */
export function revealing(name: string | undefined, s: Secrets): boolean {
  if (!name) return false;
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return [name, spaced].some((n) => test(s.people, n) || s.titleLabels.has(norm(n)));
}

const TEXT_FIELDS = ['definition', 'comment', 'editorialNote', 'reason'] as const;
const LIST_FIELDS = ['altLabels', 'examples'] as const;

/**
 * Redacts drafted edits: free text is rewritten, alternative labels and
 * examples that name a use case or a person are dropped, and a new term whose
 * label or local name would do so is left out altogether (listed in `dropped`
 * so the change request can say why).
 */
export function redactOps(ops: ChangeOp[], s: Secrets): { ops: ChangeOp[]; dropped: string[] } {
  const dropped: string[] = [];
  const out: ChangeOp[] = [];
  for (const op of ops) {
    const o = structuredClone(op) as Record<string, unknown>;
    if ([o.label, o.localName, o.newLocalName].some((n) => revealing(n as string | undefined, s))) {
      dropped.push(String(o.localName ?? o.label));
      continue;
    }
    const scrub = (rec: Record<string, unknown>) => {
      for (const f of TEXT_FIELDS) if (typeof rec[f] === 'string') rec[f] = redactText(rec[f] as string, s);
      for (const f of LIST_FIELDS)
        if (Array.isArray(rec[f])) rec[f] = (rec[f] as unknown[]).filter((v) => typeof v !== 'string' || (!test(s.titles, v) && !test(s.people, v)));
      if (typeof rec.label === 'string' && revealing(rec.label, s)) delete rec.label;
    };
    scrub(o);
    if (o.set && typeof o.set === 'object') scrub(o.set as Record<string, unknown>);
    out.push(o as unknown as ChangeOp);
  }
  return { ops: out, dropped };
}
