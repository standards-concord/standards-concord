import type { PendingChange } from './diagramProposals';

const PREFIX = 'concord.diagramProposals.';
const key = (userId: string, ontologyId: string) => `${PREFIX}${encodeURIComponent(userId)}.${encodeURIComponent(ontologyId)}`;
export interface ProposalDraft { items: PendingChange[]; title: string; description: string; namespace?: string; storageError?: string; unavailableItems?: unknown[] }
const empty = (): ProposalDraft => ({ items: [], title: '', description: '' });

function validItem(value: unknown): value is PendingChange {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string') return false;
  if (p.kind === 'superclass') return typeof p.classIri === 'string' && typeof p.parent === 'string' && (p.mode === 'add' || p.mode === 'replace');
  if (!['class', 'attribute', 'relationship'].includes(String(p.kind)) || !['localName', 'label', 'definition'].every((k) => typeof p[k] === 'string')) return false;
  if (p.kind === 'class') return p.parent === undefined || typeof p.parent === 'string';
  if (!['any', 'min', 'exactly', 'max'].includes(String(p.howMany))) return false;
  return p.kind === 'attribute' ? typeof p.classIri === 'string' && typeof p.range === 'string' : typeof p.from === 'string' && typeof p.to === 'string';
}
export function readProposalDraft(userId: string, ontologyId: string): ProposalDraft {
  try {
    const draft = JSON.parse(localStorage.getItem(key(userId, ontologyId)) ?? 'null');
    if (draft && Array.isArray(draft.items) && typeof draft.title === 'string' && typeof draft.description === 'string') {
      const unavailableItems = [...(Array.isArray(draft.unavailableItems) ? draft.unavailableItems : []), ...draft.items.filter((p: unknown) => !validItem(p))];
      // Older drafts stored superclass snapshots. Retain their intent, never replay the snapshot.
      const items: PendingChange[] = draft.items.filter(validItem).map((p: PendingChange) => p.kind === 'superclass'
        ? { id: p.id, kind: p.kind, classIri: p.classIri, parent: p.parent, mode: p.mode } : p);
      return { items, title: draft.title, description: draft.description,
        ...(typeof draft.namespace === 'string' ? { namespace: draft.namespace } : {}),
        ...(typeof draft.storageError === 'string' ? { storageError: draft.storageError } : {}),
        ...(unavailableItems.length ? { unavailableItems, storageError: 'Some saved proposals cannot be read. Discard this draft before sending.' } : {}),
      };
    }
  } catch { /* Storage unavailable or damaged. */ }
  return empty();
}
export function writeProposalDraft(userId: string, ontologyId: string, draft: ProposalDraft) {
  try {
    if (draft.items.length || draft.storageError) localStorage.setItem(key(userId, ontologyId), JSON.stringify(draft));
    else localStorage.removeItem(key(userId, ontologyId));
  } catch { /* The form still works without storage. */ }
}
export function clearDiagramProposalStorage() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* Storage unavailable. */ }
}

/** Only references to terms minted by this draft move; existing/external IRIs stay intact. */
export function rebaseProposalDraft(draft: ProposalDraft, namespace: string): ProposalDraft {
  if (draft.namespace === namespace) return draft;
  if (!draft.namespace && draft.items.length) return { ...draft, storageError: 'This saved draft has no namespace. Discard it before sending.' };
  const minted = new Map(draft.items.filter((p) => p.kind === 'class').map((p) => [draft.namespace + p.localName, namespace + p.localName]));
  const rebase = (iri: string) => minted.get(iri) ?? iri;
  return { ...draft, namespace, items: draft.items.map((p) => {
    switch (p.kind) {
      case 'class': return { ...p, parent: p.parent ? rebase(p.parent) : undefined };
      case 'attribute': return { ...p, classIri: rebase(p.classIri) };
      case 'relationship': return { ...p, from: rebase(p.from), to: rebase(p.to) };
      case 'superclass': return { ...p, classIri: rebase(p.classIri), parent: rebase(p.parent) };
    }
  }) };
}
