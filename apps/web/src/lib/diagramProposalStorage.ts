import type { PendingChange } from './diagramProposals';

const PREFIX = 'concord.diagramProposals.';
const key = (userId: string, ontologyId: string) => `${PREFIX}${encodeURIComponent(userId)}.${encodeURIComponent(ontologyId)}`;
export interface ProposalDraft { items: PendingChange[]; title: string; description: string }
const empty = (): ProposalDraft => ({ items: [], title: '', description: '' });

function validItem(value: unknown): value is PendingChange {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string') return false;
  if (p.kind === 'superclass') return typeof p.classIri === 'string' && typeof p.parent === 'string' && (p.mode === 'add' || p.mode === 'replace') && Array.isArray(p.superClasses) && p.superClasses.every((i) => typeof i === 'string');
  if (!['class', 'attribute', 'relationship'].includes(String(p.kind)) || !['localName', 'label', 'definition'].every((k) => typeof p[k] === 'string')) return false;
  if (p.kind === 'class') return p.parent === undefined || typeof p.parent === 'string';
  if (!['any', 'min', 'exactly', 'max'].includes(String(p.howMany))) return false;
  return p.kind === 'attribute' ? typeof p.classIri === 'string' && typeof p.range === 'string' : typeof p.from === 'string' && typeof p.to === 'string';
}
export function readProposalDraft(userId: string, ontologyId: string): ProposalDraft {
  try {
    const draft = JSON.parse(localStorage.getItem(key(userId, ontologyId)) ?? 'null');
    if (draft && Array.isArray(draft.items) && draft.items.every(validItem) && typeof draft.title === 'string' && typeof draft.description === 'string') return draft;
  } catch { /* Storage unavailable or damaged. */ }
  return empty();
}
export function writeProposalDraft(userId: string, ontologyId: string, draft: ProposalDraft) {
  try {
    if (draft.items.length) localStorage.setItem(key(userId, ontologyId), JSON.stringify(draft));
    else localStorage.removeItem(key(userId, ontologyId));
  } catch { /* The form still works without storage. */ }
}
export function clearDiagramProposalStorage() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* Storage unavailable. */ }
}
