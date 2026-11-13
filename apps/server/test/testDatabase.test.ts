import { describe, expect, it } from 'vitest';
import { testDatabaseName } from './testDatabase.js';

describe('the test databases', () => {
  // CI runs the server suite twice against one Postgres server, first with the git store and then with the
  // database store. Both runs used the same databases, so the second found the demo ontology the first had seeded,
  // whose history was in a git repository on disk, and every test that read it failed with "No ontology at <commit>".
  it('are separate for each ontology store, so one run never finds the other’s ontologies', () => {
    expect(testDatabaseName('postgres', 'db', '3')).not.toBe(testDatabaseName('postgres', undefined, '3'));
    expect(testDatabaseName('postgres', 'git', '3')).toBe(testDatabaseName('postgres', undefined, '3'));
  });

  it('are separate for each worker', () => {
    expect(testDatabaseName('postgres', 'db', '1')).not.toBe(testDatabaseName('postgres', 'db', '2'));
  });
});
