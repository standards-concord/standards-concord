---
name: ontology-term-drafting
description: Draft or review OWL ontology terms (classes, properties, individuals, SKOS codes): reuse first, naming, one label, genus-differentia definitions, domain/range, restrictions, alignment and deprecation. Use when adding, renaming, rewording or reviewing terms in any OWL ontology.
---

# Drafting ontology terms

Use this when someone wants new terms for an OWL ontology, wants existing terms reworded or renamed, or asks you to review a set of terms. The rules follow established practice (the OBO Foundry principles, the ROBOT report checks, the OOPS! pitfall catalogue, Seppälä, Ruttenberg and Smith's definition guidelines, and FAIR vocabulary practice) and keep the ontology inside OWL 2 DL, so terms drafted this way pass the checks in the ontology-checking skill.

## 1. Before inventing anything, look for an existing term

Reuse beats invention. In this order:

1. **The ontology itself.** Search by label, synonym and definition, not just by name (a SPARQL query over `rdfs:label`, `skos:altLabel` and `skos:definition`, or the ontology's own search). A term that is close but not quite right is usually a sign to change it, or add a subclass of it, rather than a parallel term.
2. **Well-known vocabularies** that fit the meaning exactly: schema.org, SKOS, PROV-O, Dublin Core (dcterms), FOAF, OWL-Time, GeoSPARQL, vCard, DCAT, ORG. Services such as Linked Open Vocabularies (LOV) or the OLS help find candidates.
3. **Only then** mint a new term in the ontology's own namespace.

When you reuse an outside term, check its definition, not its name ("schema:Event" is not any event in the everyday sense). If it is close but not exact, mint your own term and record the relationship with a mapping (see section 6) instead of misusing it.

## 2. Choose the right kind of term

| You have | Model it as |
|---|---|
| A kind of thing whose members you'd count ("a volunteering opportunity") | `owl:Class` |
| A relationship between two things | `owl:ObjectProperty` with a class domain and range |
| An attribute with a literal value (date, number, text) | `owl:DatatypeProperty` with an XSD range |
| A fixed, governed list of values (status, category, country code) | A SKOS code list: `skos:ConceptScheme` + `skos:Concept` codes (see section 7) |
| One specific, named thing that every user shares | `owl:NamedIndividual` |

Common mistakes:
- A class for what is really a value ("ActiveOpportunity", "UrgentOpportunity"): usually a status code or a boolean.
- A property for what is really a class ("hasVolunteeringRecord" with a string range): if it has its own attributes, it is a class.
- An IRI used as both an object and a datatype property: not allowed in OWL 2 DL. Using one IRI as both a class and an individual (punning) is allowed but confusing; avoid it unless you mean it.

## 3. Name it

- **Classes**: UpperCamelCase singular nouns, letters and digits only: `VolunteeringOpportunity`, not `Volunteering_Opportunities`.
- **Properties**: lowerCamelCase, a verb phrase or a noun that reads as a relation: `hasRole`, `startDate`, `organisedBy`.
- **Individuals and codes**: letters, digits and hyphens.
- Name what the thing *is*, not how one system stores it (`startDate`, not `start_dt_field`). Avoid abbreviations the definition has to explain.
- Keep the ontology's namespace: new terms go in its `vann:preferredNamespaceUri`.
- Never reuse an IRI for a different meaning. A published IRI's meaning is fixed.

(Some communities, such as OBO, use opaque numeric IRIs like `EX_0000123` with the readable name only in the label. Follow the ontology's existing convention.)

## 4. Label it

- **Exactly one `rdfs:label` per language**, and always one in English (or the ontology's main language). SKOS codes and code lists use `skos:prefLabel` instead.
- Lower case except for proper nouns ("volunteering opportunity", not "Volunteering Opportunity"), no trailing full stop, no leading or doubled spaces.
- Synonyms, acronyms and older names go in `skos:altLabel`, never in a second `rdfs:label`.
- No two terms in the ontology may share a label (case-insensitive). If two concepts need the same everyday word, the label must say which is which.

## 5. Define it

Every term that isn't deprecated gets **exactly one definition** (`skos:definition`, or the ontology's chosen definition property such as `IAO:0000115`) in the main language. Write it for a reader who was not in the conversation.

**Classes: genus and differentia.** "A *<superclass label>* that *<what distinguishes it>*."

> **volunteering opportunity**: An *activity* that an organisation offers to people who give their time without pay, with a role, a place and a schedule.

- The genus is the named superclass (or the named class in its logical definition), and the definition should mention it, by label or plural.
- Don't start the definition with the term's own label ("A volunteering opportunity is…"), and don't just restate the label. Both are circular.
- Define the intension (what makes something a member), not examples. Examples go in `skos:example`.
- Say what it is not when there is an easy confusion: "Unlike a shift, …".

**Properties.** Say what it relates and what the value means, including units and time zone where relevant.

> **hours volunteered**: The total time, in hours, that a volunteer gave during one volunteering activity.

**Codes.** One sentence that lets two people classify the same case the same way.

Keep personal or confidential details (people's names, private project titles, quotes from interviews) out of definitions and comments: ontologies are usually published. Record where a term came from with `dcterms:source` (a public reference), or in the change's description.

## 6. Place it: hierarchy, domain, range, restrictions

- **Superclass.** Every class except a handful of top-level ones has a named superclass. Check that *every* member of the new class is a member of the superclass.
- **Domain and range.** Give local properties one domain and one range. Several `rdfs:domain` axioms mean the *intersection*, not "either"; if you mean either, use a union class (`owl:unionOf`). Object properties range over classes; datatype properties over datatypes. Remember that in OWL, domain and range are inferences, not constraints: a value outside the range makes the reasoner infer its type, not reject it. Use SHACL (ontology-checking skill) to reject data.
- **Datatypes.** Prefer the OWL 2 datatype map: `xsd:string`, `xsd:boolean`, `xsd:decimal`, `xsd:integer`, `xsd:dateTime`, `xsd:anyURI`. `xsd:date` and `xsd:duration` are fine for data but are outside the OWL 2 datatype map, so DL reasoners can't check their values (most treat them as `rdfs:Literal` or refuse them); choose them knowingly.
- **Restrictions.** Use an existential restriction (`some`) for what every member must have. Use cardinality only when the use case demands an exact count. `only` (universal) restrictions and disjointness are strong claims: use them only where members genuinely cannot share, and never add them to existing classes casually (breaking change, see section 8).
- **Characteristics** (functional, transitive, inverse…) also change what data means; functional means at most one value.
- Keep hierarchies navigable: more than about seven direct subclasses suggests an intermediate grouping.
- Avoid subclass cycles (they make the classes equivalent) and asserted equivalent pairs of named classes (merge them: deprecate one, replaced by the other).

### Alignment with other vocabularies

To relate your term to an outside one without importing it, use mapping annotations on your term: `skos:exactMatch`, `skos:closeMatch`, `skos:broadMatch`, `skos:narrowMatch`, `skos:relatedMatch` or `rdfs:seeAlso`. Pick the weakest one that is true; `exactMatch` is transitive and asserts interchangeability. Use `rdfs:subClassOf` or `owl:equivalentClass` to an outside term only if you also import it and have checked the import with a reasoner (ontology-checking skill). Adding a mapping is additive; removing one breaks integrations that rely on it.

## 7. Code lists (SKOS)

- The list is a `skos:ConceptScheme`; each code is a `skos:Concept` in the ontology's namespace. If the ontology must stay in OWL 2 DL, also declare them `owl:NamedIndividual` and declare the SKOS terms you use rather than importing all of SKOS.
- Each code has one `skos:prefLabel` per language, a definition, `skos:inScheme` its list, and usually a `skos:notation` (the stored code, unique within the list).
- Hierarchy within a list: `skos:broader` to a code in the same list, or `skos:topConceptOf` the list. No broader cycles.
- A property that takes values from one list can range over `skos:Concept and (skos:inScheme value ex:List)`; in SHACL that becomes `sh:in` with every code, deprecated ones included, so old data still validates.
- Never change or reuse a notation: stored data depends on it. Deprecate the code and add a new one.

## 8. Changing published terms

Published terms are a contract with everyone who uses them. Treat versions semantically:

| Level | Examples |
|---|---|
| **Patch** (no change in meaning) | Rewording a label, comment or example; rewording a definition *that keeps the same referents*; header metadata |
| **Minor** (additive, existing data stays valid) | New term; new code; deprecating a term (IRI kept); renaming by minting a new IRI and deprecating the old; adding a mapping; broadening a domain or range; a new axiom that only relates an existing term to a new one |
| **Major** (breaking) | Removing a term, superclass, restriction or mapping; adding a superclass between existing classes; narrowing a domain or range; adding disjointness, `only`, `some` or cardinality restrictions to existing classes; changing a datatype range, a property characteristic, an inverse or the namespace; changing or removing a code's notation; changing what a definition covers |

- **Rewording a definition** is a patch *only if it keeps the same referents* (OBO principle 19): every thing that was a member is still one, and nothing new is. If the meaning changes, it is a new term: mint it and deprecate the old one. Have someone other than the author confirm which it is.
- **Renaming**: mint the new IRI, deprecate the old one with `dcterms:isReplacedBy` pointing to the new one. Removing an IRI outright breaks everyone who used it; don't.
- **Deprecating**: add `owl:deprecated true`, a reason in `skos:historyNote` (or `rdfs:comment`), and `dcterms:isReplacedBy` (or `IAO:0100001`) where there is a successor. Don't point it at a term that is itself deprecated, and stop using the deprecated term in other axioms.
- Prefer an additive alternative (a new subclass or property) to a breaking change wherever one exists.

## 9. Output format

When you draft terms, give each one as a short block a reviewer can scan, then the Turtle:

```
Kind: class
Name: ex:VolunteeringActivity
Label: volunteering activity
Definition: An activity in which a volunteer gives time to an organisation, recorded with its date and hours.
Superclass: ex:Activity
Properties: ex:hoursVolunteered (xsd:decimal, exactly one), ex:volunteer (ex:Volunteer, some)
Alt labels: volunteering session
Reuse checked: schema:Event (too broad: any happening), prov:Activity (mapped as skos:closeMatch)
Change level: minor (new term)
Why: needed to report hours given per activity.
```

```turtle
ex:VolunteeringActivity a owl:Class ;
  rdfs:label "volunteering activity"@en ;
  skos:definition "An activity in which a volunteer gives time to an organisation, recorded with its date and hours."@en ;
  skos:altLabel "volunteering session"@en ;
  rdfs:subClassOf ex:Activity ,
    [ a owl:Restriction ; owl:onProperty ex:volunteer ; owl:someValuesFrom ex:Volunteer ] ;
  skos:closeMatch prov:Activity .
```

Then check them with the ontology-checking skill.

## Quick checklist

- [ ] Searched the ontology and well-known vocabularies first
- [ ] Right kind of term; no class-for-a-value or property-for-a-class
- [ ] UpperCamelCase class / lowerCamelCase property (or the ontology's convention), in its namespace
- [ ] One `rdfs:label` per language (or `skos:prefLabel` for codes), unique in the ontology
- [ ] One definition, genus-differentia for classes, not circular, no confidential details
- [ ] Named superclass; one domain and range; OWL 2 datatype where values matter
- [ ] Restrictions and characteristics only where the use case requires them
- [ ] Changes to published terms keep meaning, or mint and deprecate instead
