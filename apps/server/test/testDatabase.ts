/** The Postgres database a test worker uses (setup.ts): one per worker and per ontology store. */
export const testDatabaseName = (base: string, ontologyStore: string | undefined, worker: string | undefined) =>
  `${base}${ontologyStore === 'db' ? '_dbstore' : ''}_w${worker ?? '1'}`;
