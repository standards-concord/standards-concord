/**
 * The name of the dataset wrapper in generated classes. The generator renames
 * it when an ontology class already has the name (FooDataset becomes
 * FooDataset2), so it is read from the code when there is code; otherwise it
 * is the name the generator starts from ('volunteering' gives VolunteeringDataset).
 */
export function datasetClassName(code: string | undefined, slug: string): string {
  const fromCode = code && /^export class (\w+) extends DatasetWrapper\b/m.exec(code)?.[1];
  if (fromCode) return fromCode;
  const id = slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return `${/^[0-9]/.test(id) ? `_${id}` : id || 'Ontology'}Dataset`;
}
