/**
 * Change logs and data migration:
 *  - `toKGCL` renders change ops as KGCL-style change statements (Knowledge Graph
 *    Change Language; Hegde et al. 2024, arXiv:2409.13906) for human-readable changelogs.
 *  - `migrationSparql` produces a SPARQL UPDATE that rewrites instance data from
 *    deprecated/renamed terms to their replacements (gist-style migration queries).
 */
import type { ChangeOp, OntologyDiff, Restriction } from './types.js';
import { compactIRI, expandIRI } from './ns.js';
import type { OntologyGraph } from './graph.js';

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * KGCL-style change statements, one per line; constructs KGCL cannot express are
 * emitted as `#` comments. `namespace` (addition) is used to name newly minted
 * terms; without it they are written as `:LocalName`.
 */
export function toKGCL(ops: ChangeOp[], prefixes: Record<string, string>, namespace?: string): string[] {
  const c = (iri: string) => {
    const full = expandIRI(iri, prefixes);
    const short = compactIRI(full, prefixes);
    return short === full ? `<${full}>` : short;
  };
  const mint = (local: string) => (namespace ? c(namespace + local) : `:${local}`);
  const restriction = (cls: string, r: Restriction, verb: 'create' | 'delete'): string => {
    const filler = r.filler ? c(r.filler) : r.literal !== undefined ? JSON.stringify(r.literal) : '?';
    // KGCL edges between classes denote existential restrictions (X SubClassOf p some Y).
    if (r.kind === 'some') return `${verb} edge ${cls} ${c(r.property)} ${filler}`;
    const card = r.cardinality !== undefined ? ` ${r.cardinality}` : '';
    return `# ${verb === 'create' ? 'add' : 'remove'} axiom (no KGCL form): ${cls} SubClassOf ${c(r.property)} ${r.kind}${card} ${filler}`;
  };
  const out: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'addConceptScheme':
        out.push(`# create code list ${mint(op.localName)} “${op.label}”`);
        break;
      case 'addConcept':
        out.push(`# create code ${mint(op.localName)} “${op.label}”${op.notation ? ` (${op.notation})` : ''}`, `create edge ${mint(op.localName)} skos:inScheme ${c(op.scheme)}`, `create edge ${mint(op.localName)} ${op.broader ? 'skos:broader' : 'skos:topConceptOf'} ${c(op.broader ?? op.scheme)}`);
        break;
      case 'moveConcept':
        out.push(`# move code ${c(op.iri)} ${op.broader ? `under ${c(op.broader)}` : 'to top level'}`);
        break;
      case 'setCodeList':
        out.push(`# ${op.scheme ? `set code list ${c(op.scheme)} on` : 'clear code list on'} ${c(op.property)}`);
        break;
      case 'addClass':
      case 'addObjectProperty':
      case 'addDatatypeProperty':
      case 'addIndividual': {
        const id = mint(op.localName);
        const what = { addClass: 'class', addObjectProperty: 'object property', addDatatypeProperty: 'data property', addIndividual: 'individual' }[op.op];
        out.push(`create ${what} ${id} ${q(op.label)}`);
        if (op.definition) out.push(`add definition ${q(op.definition)} to ${id}`);
        for (const a of op.altLabels ?? []) out.push(`create exact synonym ${q(a)} for ${id}`);
        if (op.op === 'addClass') {
          for (const s of op.subClassOf ?? []) out.push(`create edge ${id} rdfs:subClassOf ${c(s)}`);
          for (const e of op.equivalentTo ?? []) out.push(`create edge ${id} owl:equivalentClass ${c(e)}`);
          for (const d of op.disjointWith ?? []) out.push(`create edge ${id} owl:disjointWith ${c(d)}`);
          for (const r of op.restrictions ?? []) out.push(restriction(id, r, 'create'));
        } else if (op.op === 'addIndividual') {
          for (const t of op.types) out.push(`create edge ${id} rdf:type ${c(t)}`);
        } else {
          for (const d of op.domain ?? []) out.push(`create edge ${id} rdfs:domain ${c(d)}`);
          for (const r of op.range ?? []) out.push(`create edge ${id} rdfs:range ${c(r)}`);
          if (op.op === 'addObjectProperty' && op.codeList) out.push(`# values for ${id} from code list ${c(op.codeList)}`);
          for (const s of op.subPropertyOf ?? []) out.push(`create edge ${id} rdfs:subPropertyOf ${c(s)}`);
        }
        break;
      }
      case 'updateConcept':
        out.push(`# update code or code list ${c(op.iri)}: ${Object.entries(op.set).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join('; ')}`);
        break;
      case 'updateAnnotations': {
        const id = c(op.iri);
        const s = op.set;
        if (s.label !== undefined) out.push(`rename ${id} to ${q(s.label)}`);
        if (s.definition !== undefined) out.push(`change definition of ${id} to ${q(s.definition)}`);
        if (s.comment !== undefined) out.push(`change comment of ${id} to ${q(s.comment)}`);
        for (const a of s.altLabels ?? []) out.push(`create exact synonym ${q(a)} for ${id}`);
        for (const [p, vs] of Object.entries(s.mappings ?? {})) for (const v of vs) out.push(`create edge ${id} ${c(p)} ${c(v)}`);
        if (s.examples || s.editorialNote || s.source) out.push(`# update annotations of ${id}: ${Object.keys(s).join(', ')}`);
        break;
      }
      case 'setSuperClasses':
        out.push(`# set superclasses of ${c(op.iri)}`);
        for (const s of op.superClasses) out.push(`create edge ${c(op.iri)} rdfs:subClassOf ${c(s)}`);
        break;
      case 'setDomainRange':
        for (const d of op.domain ?? []) out.push(`create edge ${c(op.iri)} rdfs:domain ${c(d)}`);
        for (const r of op.range ?? []) out.push(`create edge ${c(op.iri)} rdfs:range ${c(r)}`);
        break;
      case 'addRestriction': out.push(restriction(c(op.classIri), op.restriction, 'create')); break;
      case 'removeRestriction': out.push(restriction(c(op.classIri), op.restriction, 'delete')); break;
      case 'addDisjointness':
        out.push(op.classes.length === 2 ? `create edge ${c(op.classes[0])} owl:disjointWith ${c(op.classes[1])}` : `# add axiom: DisjointClasses(${op.classes.map(c).join(' ')})`);
        break;
      case 'removeDisjointness':
        out.push(op.classes.length === 2 ? `delete edge ${c(op.classes[0])} owl:disjointWith ${c(op.classes[1])}` : `# remove axiom: DisjointClasses(${op.classes.map(c).join(' ')})`);
        break;
      case 'setCharacteristics':
        out.push(`# set characteristics of ${c(op.iri)}: ${op.characteristics.join(', ') || 'none'}`);
        break;
      case 'deprecateConcept':
      case 'deprecateTerm':
        out.push(op.replacedBy ? `obsolete ${c(op.iri)} with replacement ${c(op.replacedBy)}` : `obsolete ${c(op.iri)}`);
        break;
      case 'removeTerm': out.push(`delete ${c(op.iri)}`); break;
      case 'renameTerm': {
        // An IRI change is an obsoletion with a replacement in KGCL terms.
        out.push(`create class ${mint(op.newLocalName)}`, `obsolete ${c(op.iri)} with replacement ${mint(op.newLocalName)}`);
        break;
      }
      case 'setMetadata': out.push(`# set ontology metadata: ${Object.keys(op.set).join(', ')}`); break;
      case 'addImport': out.push(`# add import <${op.iri}>`); break;
    }
  }
  return out;
}

/**
 * SPARQL 1.1 UPDATE that migrates instance data from terms deprecated (or renamed)
 * in this change to their dcterms:isReplacedBy targets: classes as rdf:type
 * objects, properties as predicates, individuals as subjects/objects. Removed
 * terms without a replacement are listed as comments.
 */
export function migrationSparql(before: OntologyGraph, after: OntologyGraph, diff: OntologyDiff): string {
  const prefixes = { ...before.prefixes, ...after.prefixes };
  const c = (iri: string) => compactIRI(iri, prefixes);
  const ops: string[] = [];
  const notes: string[] = [];
  for (const t of diff.terms) {
    if (t.kind === 'ontology') continue;
    if (t.change === 'removed') {
      if (!diff.terms.some((x) => x.iri === t.iri && x.change === 'added')) notes.push(`# ${c(t.iri)} was removed without a replacement; data using it must be reviewed by hand.`);
      continue;
    }
    if (t.change !== 'deprecated') continue;
    const view = after.term(t.iri);
    const target = view?.replacedBy;
    if (!target) {
      notes.push(`# ${c(t.iri)} was deprecated without a replacement; no automatic migration.`);
      continue;
    }
    const [o, n] = [`<${t.iri}>`, `<${target}>`];
    const header = `# ${c(t.iri)} → ${c(target)}`;
    if (t.kind === 'class') {
      ops.push(`${header}\nDELETE { ?s a ${o} } INSERT { ?s a ${n} } WHERE { ?s a ${o} }`);
    } else if ((t.kind === 'individual' || t.kind === 'concept' || t.kind === 'conceptScheme')) {
      ops.push(`${header}\nDELETE { ${o} ?p ?v } INSERT { ${n} ?p ?v } WHERE { ${o} ?p ?v }`);
      ops.push(`DELETE { ?s ?p ${o} } INSERT { ?s ?p ${n} } WHERE { ?s ?p ${o} }`);
    } else {
      ops.push(`${header}\nDELETE { ?s ${o} ?v } INSERT { ?s ${n} ?v } WHERE { ?s ${o} ?v }`);
    }
  }
  const lines = [
    `# Migration for ${after.ontologyIRI || before.ontologyIRI}${after.metadata().versionInfo ? ` ${after.metadata().versionInfo}` : ''}`,
    `# Generated from dcterms:isReplacedBy links on deprecated terms. Run against instance data, not the ontology.`,
    ...notes,
  ];
  if (!ops.length) return lines.concat('# Nothing to migrate.').join('\n') + '\n';
  return lines.join('\n') + '\n\n' + ops.join(' ;\n\n') + '\n';
}
