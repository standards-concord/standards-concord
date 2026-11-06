import type { Completion } from '@codemirror/autocomplete';
import type { OntologyView } from '@concord/shared';
import { allTerms } from './ontology';
import { insertTerm } from './prefixes';

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}

/**
 * Autocomplete for an ontology's terms in a SPARQL or Turtle editor: every term as a prefixed
 * name, findable by its label too. Accepting one adds the PREFIX (or @prefix) declaration if the
 * text doesn't have it yet. Used by Query and Validate data.
 */
export function termCompletions(view: OntologyView | undefined, lang: 'sparql' | 'turtle'): Completion[] {
  if (!view) return [];
  const pfx = view.prefixes;
  return allTerms(view).flatMap((t) => {
    const c = short(t.iri, pfx);
    if (c === t.iri) return [];
    const p = c.slice(0, c.indexOf(':'));
    const apply: Completion['apply'] = (v, _completion, from, to) => {
      // Reuse a matching declaration, add one if the prefix is free, or use the full IRI if it's bound elsewhere.
      const { declaration, text } = insertTerm(v.state.doc.toString(), lang, p, pfx[p], t.iri, from);
      v.dispatch({
        changes: [...(declaration ? [{ from: 0, insert: declaration }] : []), { from, to, insert: text }],
        selection: { anchor: from + text.length + (declaration?.length ?? 0) },
      });
    };
    const type = t.kind === 'class' ? 'class' : t.kind === 'individual' ? 'constant' : 'property';
    const base = { detail: t.label, type, info: t.definition, apply };
    return [{ label: c, ...base }, ...(t.label ? [{ label: t.label, displayLabel: `${t.label} → ${c}`, ...base, detail: undefined, boost: -1 }] : [])];
  });
}
