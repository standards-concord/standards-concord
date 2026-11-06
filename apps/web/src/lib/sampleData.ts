import type { OntologySummary } from '@concord/shared';
import { useLocalStorage } from './hooks';
import { useSession } from './session';

/**
 * The sample data for an ontology: edited and checked on Validate data, and queried on Query
 * (as the "sample records" dataset). One copy per ontology, account and browser, kept in this
 * browser only, so both pages always see the same records.
 */

/** Sample data for the demo (volunteering) ontology, with a few problems for the checker to find. */
export const DEMO_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Example records. A few things are deliberately wrong, so the check has
# something to find: the Saturday shift's minimum age is written as text
# ("sixteen"), "summary" is misspelt, and neither shift names a role.

ex:foodbank a ${prefix}:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" ;
  ${prefix}:offersOpportunity ex:saturday-shift, ex:park-clean-up .

ex:saturday-shift a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Saturday food bank shift" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "sixteen" ;
  ${prefix}:sumary "Sort and pack food parcels." .

ex:park-clean-up a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Park clean-up" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "14"^^xsd:nonNegativeInteger .
`;

/** A starting point for any other ontology. */
export const EMPTY_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Add example records that use this ontology, for example:
# ex:thing1 a ${prefix}:SomeClass ; rdfs:label "Thing one" .
`;

export const defaultSampleData = (o: Pick<OntologySummary, 'demo' | 'namespace' | 'prefix'>) => (o.demo ? DEMO_DATA : EMPTY_DATA)(o.namespace, o.prefix);

/** Where an account's sample data for an ontology is kept (the key Query has always used). */
export const sampleDataKey = (account: string, ontologyId: string) => `concord.query.${account}.${ontologyId}.data`;

/** The signed-in account's sample data for an ontology, and a setter that keeps it. */
export function useSampleData(ontologyId: string, o: Pick<OntologySummary, 'demo' | 'namespace' | 'prefix'>) {
  const { session } = useSession();
  const account = session?.user?.id ?? 'guest';
  return useLocalStorage(sampleDataKey(account, ontologyId), defaultSampleData(o));
}

/**
 * Whether sample data holds any statement, not just prefix and base declarations and comments (the starting template
 * has none), read without a full parse so Query can decide at once whether to run over it. Works whatever the layout:
 * several declarations or a declaration and a statement on one line, and names that merely start with "prefix".
 *
 * IRIs and comments are read in one pass, left to right, so whichever starts first wins: the "#" in an IRI such as
 * <https://example.org/x#> is not a comment, and quotes or a link inside a comment are part of the comment.
 * Strings need no handling: every statement starts with a subject outside any string, which no "#" in a later
 * string can hide, and declarations hold no strings. (Removing strings first used to be wrong: quotes in two
 * comments were read as one long string, swallowing the statement between them.)
 */
export function hasSampleRecords(data: string): boolean {
  const rest = data
    .replace(/<[^>\s]*>|#[^\n]*/g, (m) => (m[0] === '<' ? '<>' : ' '))
    // Turtle declarations end with "."; SPARQL-style ones don't. The keyword must be followed by space, so a name
    // like prefix:thing or base:x is a statement, not a declaration.
    .replace(/@prefix\s+[\w.-]*:\s*<>\s*\./gi, ' ')
    .replace(/@base\s+<>\s*\./gi, ' ')
    .replace(/(^|\s)prefix\s+[\w.-]*:\s*<>/gi, ' ')
    .replace(/(^|\s)base\s+<>/gi, ' ');
  return rest.trim() !== '';
}
