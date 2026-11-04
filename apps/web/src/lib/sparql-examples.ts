/** Ready-made queries for the SPARQL editor's Examples menu. */

export interface SparqlExample {
  id: string;
  title: string;
  description: string;
  query: string;
}

const P = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
};

function prefixes(prefix: string, ns: string, use: (keyof typeof P)[]) {
  return [`PREFIX ${prefix}: <${ns}>`, ...use.map((p) => `PREFIX ${p}: <${P[p]}>`)].join('\n');
}

export function sparqlExamples(prefix: string, ns: string): SparqlExample[] {
  return [
    {
      id: 'classes',
      title: 'Classes with definitions',
      description: 'Every class, its label and its definition.',
      query: `${prefixes(prefix, ns, ['rdfs', 'skos', 'owl'])}

SELECT ?class ?label ?definition WHERE {
  ?class a owl:Class ; rdfs:label ?label .
  OPTIONAL { ?class skos:definition ?definition }
  FILTER(isIRI(?class))
}
ORDER BY ?label`,
    },
    {
      id: 'hierarchy',
      title: 'Class hierarchy',
      description: 'Each class with its direct named superclass.',
      query: `${prefixes(prefix, ns, ['rdfs', 'owl'])}

SELECT ?class ?superclass WHERE {
  ?class a owl:Class ; rdfs:subClassOf ?superclass .
  FILTER(isIRI(?class) && isIRI(?superclass))
}
ORDER BY ?superclass ?class`,
    },
    {
      id: 'object-properties',
      title: 'Relationships (object properties)',
      description: 'How classes connect: each object property with its domain and range.',
      query: `${prefixes(prefix, ns, ['rdfs', 'owl'])}

SELECT ?property ?domain ?range WHERE {
  ?property a owl:ObjectProperty .
  OPTIONAL { ?property rdfs:domain ?domain . FILTER(isIRI(?domain)) }
  OPTIONAL { ?property rdfs:range ?range . FILTER(isIRI(?range)) }
}
ORDER BY ?property`,
    },
    {
      id: 'datatype-properties',
      title: 'Attributes (datatype properties)',
      description: 'Each datatype property with the class it describes and its value type.',
      query: `${prefixes(prefix, ns, ['rdfs', 'owl'])}

SELECT ?property ?domain ?range WHERE {
  ?property a owl:DatatypeProperty .
  OPTIONAL { ?property rdfs:domain ?domain }
  OPTIONAL { ?property rdfs:range ?range }
}
ORDER BY ?property`,
    },
    {
      id: 'missing-definitions',
      title: 'Terms missing a definition',
      description: 'A FAIR check: named classes and properties with no skos:definition.',
      query: `${prefixes(prefix, ns, ['rdf', 'skos', 'owl'])}

SELECT ?term ?type WHERE {
  VALUES ?type { owl:Class owl:ObjectProperty owl:DatatypeProperty }
  ?term a ?type .
  FILTER(isIRI(?term) && STRSTARTS(STR(?term), "${ns}"))
  FILTER NOT EXISTS { ?term skos:definition ?d }
}`,
    },
    {
      id: 'deprecated',
      title: 'Deprecated terms',
      description: 'Terms marked owl:deprecated, with their replacement if there is one.',
      query: `${prefixes(prefix, ns, ['owl'])}
PREFIX dcterms: <http://purl.org/dc/terms/>

SELECT ?term ?replacedBy WHERE {
  ?term owl:deprecated true .
  OPTIONAL { ?term dcterms:isReplacedBy ?replacedBy }
}`,
    },
    {
      id: 'instances',
      title: 'Instances by type (sample data)',
      description: 'How many things of each class are in the sample data. Run against “Ontology + sample data”.',
      query: `${prefixes(prefix, ns, ['owl'])}

SELECT ?type (COUNT(?thing) AS ?count) WHERE {
  ?thing a ?type .
  FILTER(STRSTARTS(STR(?type), "${ns}"))
  FILTER NOT EXISTS { ?thing a owl:Class }
}
GROUP BY ?type
ORDER BY DESC(?count)`,
    },
    {
      id: 'ask-consistent-labels',
      title: 'Does every class have a label?',
      description: 'An ASK query: answers yes or no.',
      query: `${prefixes(prefix, ns, ['rdfs', 'owl'])}

ASK {
  FILTER NOT EXISTS {
    ?class a owl:Class .
    FILTER(isIRI(?class))
    FILTER NOT EXISTS { ?class rdfs:label ?label }
  }
}`,
    },
  ];
}

/** SELECT, ASK, CONSTRUCT or DESCRIBE, looking past PREFIX/BASE declarations and comments. */
export type QueryForm = 'select' | 'ask' | 'construct' | 'describe' | 'unknown';

export function queryForm(query: string): QueryForm {
  let q = query.replace(/^\s*#.*$/gm, '');
  for (;;) {
    const next = q.replace(/^\s*(PREFIX\s+[^\s:]*:\s*<[^>]*>|BASE\s*<[^>]*>)/i, '');
    if (next === q) break;
    q = next;
  }
  const m = /^\s*(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i.exec(q);
  return m ? (m[1].toLowerCase() as 'select' | 'ask' | 'construct' | 'describe') : 'unknown';
}
