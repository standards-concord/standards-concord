import { describe, expect, it } from 'vitest';
import { limitOf, withoutLimit } from './sparqlLimit';

describe('outer LIMIT', () => {
  it('finds the top-level LIMIT, however it is written', () => {
    expect(limitOf('SELECT * WHERE { ?s ?p ?o } LIMIT 10')).toBe(10);
    expect(limitOf('SELECT * WHERE { ?s ?p ?o }\nlimit 5 OFFSET 10')).toBe(5);
    expect(limitOf('SELECT * WHERE { ?s ?p ?o } OFFSET 3 LIMIT 7')).toBe(7);
    expect(limitOf('SELECT * WHERE { ?s ?p ?o }\nLIMIT # one row\n1')).toBe(1);
  });

  it('ignores a subquery LIMIT, and LIMIT in strings, IRIs and comments', () => {
    expect(limitOf('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 3 } }')).toBeUndefined();
    expect(limitOf('SELECT * WHERE { ?s ?p "LIMIT 5" }')).toBeUndefined();
    expect(limitOf('SELECT * WHERE { ?s <http://e.org/LIMIT> ?o } # LIMIT 5')).toBeUndefined();
    expect(limitOf("SELECT * WHERE { ?s ?p '''}\nLIMIT 4''' }")).toBeUndefined();
  });

  it('removes only the outer LIMIT', () => {
    expect(withoutLimit('SELECT * WHERE { ?s ?p ?o }\nLIMIT 10')).toBe('SELECT * WHERE { ?s ?p ?o }\n');
    expect(withoutLimit('SELECT * WHERE { ?s ?p ?o }\nLIMIT # one row\n1')).toBe('SELECT * WHERE { ?s ?p ?o }\n');
    expect(withoutLimit('SELECT * WHERE { ?s ?p ?o } LIMIT 5 OFFSET 10')).toBe('SELECT * WHERE { ?s ?p ?o } OFFSET 10\n');
    const sub = 'SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 3 } } LIMIT 2';
    expect(withoutLimit(sub)).toBe('SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 3 } }\n');
  });
});
