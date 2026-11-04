import { describe, expect, it } from 'vitest';
import { datasetClassName } from './classes-hint';

describe('datasetClassName', () => {
  it('uses the name in the generated code, which may have been renamed to avoid an ontology class', () => {
    const code = 'export class FooDataset extends TermWrapper {}\n\nexport class FooDataset2 extends DatasetWrapper {\n}';
    expect(datasetClassName(code, 'foo')).toBe('FooDataset2');
  });

  it('falls back to the name made from the slug before the code loads', () => {
    expect(datasetClassName(undefined, 'volunteering')).toBe('VolunteeringDataset');
    expect(datasetClassName(undefined, 'open-data-2')).toBe('OpenData2Dataset');
  });
});
