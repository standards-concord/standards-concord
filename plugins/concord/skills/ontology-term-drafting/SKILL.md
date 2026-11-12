---
name: ontology-term-drafting
description: Draft or review OWL ontology terms (classes, properties, individuals, SKOS codes): reuse first, naming, one label, genus-differentia definitions, domain/range, restrictions, alignment and deprecation. Use when adding, renaming, rewording or reviewing terms.
---

# Drafting ontology terms

Use this when someone wants new terms for an ontology, wants existing terms reworded or renamed, or asks you to review a set of terms. The rules below are the ones Concord's lint, classifier and modelling prompts enforce (strict OWL 2 DL), so terms drafted this way pass its checks first time. They also hold for any OWL vocabulary outside Concord.

## 1. Before inventing anything, look for an existing term

Reuse beats invention. In this order:

1. **The ontology itself.** Search by label, synonym and definition, not just by name. With the Concord connector: `search_terms` then `get_term`. A term that is close but not quite right is usually a sign to propose a change to it, or a subclass of it, rather than a parallel term.
2. **Well-known vocabularies** that fit the meaning exactly: schema.org, SKOS, PROV-O, Dublin Core (dcterms), FOAF, OWL-Time, GeoSPARQL, vCard, DCAT, ORG.
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
- An IRI used as both a class and a property, or both an object and a datatype property. That is a lint error in Concord.

## 3. Name it

- **Classes**: UpperCamelCase singular nouns, letters and digits only: `VolunteeringOpportunity`, not `Volunteering_Opportunities`.
- **Properties**: lowerCamelCase, a verb phrase or a noun that reads as a relation: `hasRole`, `startDate`, `organisedBy`.
- **Individuals and codes**: letters, digits and hyphens.
- Name what the thing *is*, not how one system stores it (`startDate`, not `start_dt_field`). Avoid abbreviations the definition has to explain.
- Keep the ontology's namespace: new terms go in its `vann:preferredNamespaceUri`.
- Never reuse an IRI for a different meaning. A released IRI's meaning is fixed.

## 4. Label it

- **Exactly one `rdfs:label` per language**, and always one in English. SKOS codes and code lists use `skos:prefLabel` instead.
- Lower case except for proper nouns ("volunteering opportunity", not "Volunteering Opportunity"), no trailing full stop, no leading or doubled spaces.
- Synonyms, acronyms and older names go in `skos:altLabel`, never in a second `rdfs:label`.
- No two terms in the ontology may share a label (case-insensitive). If two concepts need the same everyday word, the label must say which is which.

## 5. Define it

Every non-deprecated term gets **exactly one `skos:definition`** in English. Write it for a reader who was not in the conversation.

**Classes: genus and differentia.** "A *<superclass label>* that *<what distinguishes it>*."

> **volunteering opportunity**: An *activity* that an organisation offers to people who give their time without pay, with a role, a place and a schedule.

- The genus is the named superclass (or the named class in its logical definition), and the definition must mention it, by label or plural.
- Don't start the definition with the term's own label ("A volunteering opportunity is…"), and don't just restate the label. Both are circular.
- Define the intension (what makes something a member), not examples. Examples go in `skos:example`.
- Say what it is not when there is an easy confusion: "Unlike a shift, …".

**Properties.** Say what it relates and what the value means, including units and time zone where relevant.

> **hours volunteered**: The total time, in hours, that a volunteer gave during one volunteering activity.

**Codes.** One sentence that lets two people classify the same case the same way.

**Never** put people's names, organisations, private use case titles or quotes in definitions or comments; write "a use case". Record where a term came from with `dcterms:source` (a public reference) or in the change request's reasoning.

## 6. Place it: hierarchy, domain, range, restrictions

- **Superclass.** Every class except a handful of top-level ones has a named superclass. Check that *every* member of the new class is a member of the superclass.
- **Domain and range.** Give local properties one domain and one range. Several `rdfs:domain` axioms mean the *intersection*, not "either"; if you mean either, use a union class (`owl:unionOf`). Object properties range over classes; datatype properties over datatypes.
- **Datatypes.** Prefer the OWL 2 datatype map: `xsd:string`, `xsd:boolean`, `xsd:decimal`, `xsd:integer`, `xsd:dateTime`, `xsd:anyURI`. `xsd:date` and `xsd:duration` are fine for data but OWL 2 DL reasoners can't check their values (Concord reasons with them as `rdfs:Literal` and warns), so choose them knowingly.
- **Restrictions.** Use an existential restriction (`some`) for what every member must have; derived SHACL then requires the property. Use cardinality only when the use case demands an exact count. `only` (universal) restrictions and disjointness are strong claims: use them only where members genuinely cannot share, and never add them to existing classes casually (breaking change, see section 8).
- **Characteristics** (functional, transitive, inverse…) also change what data is valid; functional means at most one value (derived SHACL `sh:maxCount 1`).
- Keep hierarchies navigable: more than about seven direct subclasses suggests an intermediate grouping.
- Avoid subclass cycles (they make the classes equivalent) and asserted equivalent pairs of named classes (merge them: deprecate one, replaced by the other).

### Alignment with other vocabularies

To relate your term to an outside one without importing it, use mapping annotations on your term: `skos:exactMatch`, `skos:closeMatch`, `skos:broadMatch`, `skos:narrowMatch`, `skos:relatedMatch` or `rdfs:seeAlso`. Pick the weakest one that is true; `exactMatch` is transitive and asserts interchangeability. Use `rdfs:subClassOf` or `owl:equivalentClass` to an outside term only if you also import it and have checked the import with a reasoner (see the ontology-checking skill). Adding a mapping is a minor change; removing one is major, because integrations rely on it.

## 7. Code lists (SKOS)

- The list is a `skos:ConceptScheme`; each code is a `skos:Concept` (both also `owl:NamedIndividual`) in the ontology's namespace.
- Each code has one `skos:prefLabel` per language, a definition, `skos:inScheme` its list, and usually a `skos:notation` (the stored code, unique within the list).
- Hierarchy within a list: `skos:broader` to a code in the same list, or `skos:topConceptOf` the list. No broader cycles.
- A property that takes values from a list ranges over `skos:Concept and (skos:inScheme value :List)`; derived SHACL turns that into `sh:in` with every code, deprecated ones included.
- Never change or reuse a notation: stored data depends on it. Deprecate the code and add a new one.

## 8. Changing released terms

Released terms are a contract. In Concord the classifier labels every change patch, minor or major, and governance follows from that.

- **Rewording a definition** is a patch *only if it keeps the same referents* (OBO principle 19): every thing that was a member is still one, and nothing new is. If the meaning changes, it is a new term: mint it and deprecate the old one. Say which it is when you propose the edit.
- **Renaming**: mint the new IRI, deprecate the old one with `dcterms:isReplacedBy` pointing to the new one (minor). Removing an IRI outright is major; don't.
- **Deprecating**: add `owl:deprecated true`, a reason in `skos:historyNote` (or `rdfs:comment`), and `dcterms:isReplacedBy` where there is a successor. Don't point `isReplacedBy` at a term that is itself deprecated, and stop using the deprecated term in other axioms.
- **Breaking (major)**: removing a term, superclass, restriction or mapping; adding a superclass between existing classes; narrowing a domain or range; adding disjointness, `only`, `some` or cardinality restrictions to existing classes; changing a datatype range, a property characteristic, an inverse or the namespace. Prefer an additive alternative (a new subclass or property) where one exists.

## 9. Output format

When you draft terms, give each one as a short block a reviewer can scan, then the Turtle:

```
Kind: class
Name: vol:VolunteeringActivity
Label: volunteering activity
Definition: An activity in which a volunteer gives time to an organisation, recorded with its date and hours.
Superclass: vol:Activity
Properties: vol:hoursVolunteered (xsd:decimal, exactly one), vol:volunteer (vol:Volunteer, some)
Alt labels: volunteering session
Reuse checked: schema:Event (too broad: any happening), prov:Activity (mapped as skos:closeMatch)
Why: a use case needs to report hours given per activity.
```

```turtle
vol:VolunteeringActivity a owl:Class ;
  rdfs:label "volunteering activity"@en ;
  skos:definition "An activity in which a volunteer gives time to an organisation, recorded with its date and hours."@en ;
  skos:altLabel "volunteering session"@en ;
  rdfs:subClassOf vol:Activity ,
    [ a owl:Restriction ; owl:onProperty vol:volunteer ; owl:someValuesFrom vol:Volunteer ] ;
  skos:closeMatch prov:Activity .
```

Then run the checks in the ontology-checking skill, or propose through Concord (concord-change-governance skill), which runs them for you.

## Quick checklist

- [ ] Searched the ontology and well-known vocabularies first
- [ ] Right kind of term; no class-for-a-value or property-for-a-class
- [ ] UpperCamelCase class / lowerCamelCase property, in the ontology namespace
- [ ] One English `rdfs:label` (or `skos:prefLabel` for codes), unique in the ontology
- [ ] One `skos:definition`, genus-differentia for classes, not circular, no private names
- [ ] Named superclass; one domain and range; OWL 2 datatype where values matter
- [ ] Restrictions and characteristics only where the use case requires them
- [ ] Changes to released terms keep meaning, or mint and deprecate instead
