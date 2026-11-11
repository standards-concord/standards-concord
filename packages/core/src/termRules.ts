/** Rules shared by the graph engine and browser proposal forms. */
export function isValidLocalName(name: string, kind: 'class' | 'property' | 'individual'): boolean {
  switch (kind) {
    case 'class': return /^[A-Z][A-Za-z0-9]*$/.test(name);
    case 'property': return /^[a-z][A-Za-z0-9]*$/.test(name);
    case 'individual': return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name);
  }
}

/** The namespace applyChangeOps uses to mint new terms. */
export function termNamespace(metadata: { iri: string; preferredNamespace?: string }, prefixes: Record<string, string>): string {
  if (metadata.preferredNamespace) return metadata.preferredNamespace;
  const iri = metadata.iri;
  if (!iri || /[#/]$/.test(iri)) return iri;
  for (const sep of ['#', '/']) if (Object.values(prefixes).includes(iri + sep)) return iri + sep;
  return iri + '#';
}
