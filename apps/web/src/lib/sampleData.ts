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
