# Ontology Engineering Practice for a Collaborative, Strict-OWL, FAIR Standards Platform

*Research brief, October 2026. Prepared as design input for an AI-assisted platform where groups co-author OWL ontologies for the Open Data Institute's open data standards. Bracketed numbers point to the reference list. Where something is the author's synthesis and not a source's stated position, it is marked "Recommendation".*

---

## 0. Executive summary

- **Requirements.** Every serious methodology starts from **competency questions (CQs)** written inside a structured requirements document. NeOn's ORSD and LOT's requirements activity give the template. SAMOD and eXtreme Design (XD) turn each CQ into an executable SPARQL test. The platform should treat CQs as first-class, versioned objects: an ontology change that breaks a CQ test fails CI.
- **Strict OWL.** "Strict" should mean five things. (a) OWL 2 DL, ideally a declared profile (EL where possible). (b) A HermiT or ELK reasoner run that must report consistency and zero unsatisfiable classes. (c) ROBOT `report` with ERROR-level checks as a gate. (d) An OOPS! pitfall scan. (e) SHACL for instance-data shapes, kept separate from the OWL semantics.
- **FAIR.** Adopt the Garijo and Poveda-Villalón best practices, score every release with FOOPS! (24 checks), and mint w3id.org persistent IRIs. Require `dcterms:title/description/license/creator/created`, `owl:versionIRI`, `owl:versionInfo`, `owl:priorVersion`, `vann:preferredNamespacePrefix/Uri`, and MOD 3.0 metadata.
- **Versioning.** Use SemVer adapted to ontologies, as the FAIR-vocabularies paper and gist (Semantic Arts) both do. Section 4.4 gives an implementable rule table. Never delete a released IRI: obsolete it with `owl:deprecated true`, `IAO:0100001 term replaced by` and `oboInOwl:consider`, following OBO principle 19.
- **Governance.** Combine an OBO/Apache-style lazy consensus for minor and patch changes with explicit approval for major changes, borrowing the schema.org steering-group sign-off and the W3C review gates. Section 5.3 proposes concrete roles and thresholds.

---

## 1. Methodologies and requirements elicitation

### 1.1 Uschold & Gruninger, and Grüninger & Fox: competency questions

Grüninger and Fox (1995) introduced **competency questions**: natural-language questions an ontology must be able to answer. They are written first as *informal CQs*, then rewritten as *formal CQs* in first-order logic (or, today, SPARQL or DL queries) over the ontology's terminology [1]. Uschold and Gruninger (1996) built this into a skeletal methodology [2]:

1. Identify purpose and scope.
2. Build the ontology: capture concepts, code them, integrate existing ontologies.
3. Evaluate.
4. Document.

The test of completeness is that the formal ontology entails the answers to every formal CQ. CQs are also stratified: higher-level CQs are answered by composing answers to lower-level ones.

**Elicitation prompts (from the motivating-scenario approach).** What problem or scenario does this ontology support? What questions must a system answer for that scenario? What are the answers, written as examples? Which terms appear in the questions and answers? Which questions depend on others?

### 1.2 METHONTOLOGY

METHONTOLOGY (Fernández-López, Gómez-Pérez and Juristo, 1997) [3] defines a life cycle based on evolving prototypes. It has:

- **management activities:** scheduling, control, quality assurance
- **development activities:** specification, conceptualisation, formalisation, implementation, maintenance
- **support activities:** knowledge acquisition, integration, evaluation, documentation, configuration management

Its specification step produces an *ontology requirements specification* covering purpose, level of formality, scope (via CQs), and sources of knowledge. Conceptualisation proceeds through a fixed sequence of intermediate representations:

1. glossary of terms
2. concept taxonomies
3. ad hoc binary relation diagrams
4. concept dictionary
5. tables of relations, attributes, constants, formal axioms and rules
6. instances

This sequence is a useful scaffold for AI-assisted drafting: the platform can generate each table and have humans approve it.

### 1.3 NeOn and the ORSD

The NeOn Methodology [4] defines nine scenarios for building ontology networks, ranging from building from scratch to reusing and re-engineering ontological and non-ontological resources. Its requirements step is supported by the **Ontology Requirements Specification Document (ORSD)** template (Suárez-Figueroa, Gómez-Pérez and Villazón-Terrazas, 2009) [5]. The ORSD fields are:

| ORSD slot | Elicitation question |
|---|---|
| 1. Purpose | Why is this ontology being built? What is its main goal? |
| 2. Scope | Which domain or part of a domain? What level of granularity? |
| 3. Implementation language | OWL 2 DL? Which profile? |
| 4. Intended end-users | Who will use it (personas, organisations)? |
| 5. Intended uses | What will they do with it (scenarios, applications)? |
| 6a. Non-functional requirements | Multilinguality, naming policy, standards conformance, licence, performance |
| 6b. Functional requirements | CQs grouped by topic, each with an example answer |
| 7. Pre-glossary of terms | Terms from the CQs, terms from the answers, and named objects (individuals) |

NeOn also prescribes how to **elicit the CQs**: write them top-down, bottom-up or middle-out with domain experts, often on cards. Then group them by topic (card sorting), validate them (check for duplicates, conflicts and coverage), and prioritise them. The pre-glossary, extracted from the CQs and their answers, seeds the term list and a reuse search.

### 1.4 LOT (Linked Open Terms)

LOT [6] is NeOn's industrially streamlined successor, from the same UPM group. It has four activities: requirements specification, implementation, publication and maintenance.

- **Implementation** runs in sprints: conceptualisation (Chowlk diagram notation), reuse, encoding (OWL plus metadata) and evaluation.
- **Requirements specification** has these sub-steps:
  1. use-case specification
  2. data exchange identification (collect sample data and standards)
  3. purpose and scope identification
  4. functional requirements proposal, as CQs or as natural-language statements ("facts")
  5. completion and validation of the requirements
  6. formalisation of the requirements as **tests**, using the Themis test language and tool [7]

Requirements are tracked as issues in a Git repository. Publication goes through Widoco (documentation), content negotiation and a w3id IRI. Evaluation uses OOPS! and Themis.

### 1.5 eXtreme Design and ontology design patterns

eXtreme Design (XD) (Presutti, Blomqvist and others, 2009–2016) [8] is a test-driven, pair-design method built on **Content Ontology Design Patterns (CODPs)**, catalogued at ontologydesignpatterns.org [9]. Its loop:

1. Collect user stories.
2. Extract CQs, contextual statements and reasoning requirements.
3. Match the CQs against the CQs that each pattern already answers.
4. Specialise the chosen pattern into a module.
5. Write unit tests: CQ verification (SPARQL over test data), inference verification, and error provocation (insert bad data and expect inconsistency).
6. Integrate the module.

Each CODP is published *with its own CQs*, so matching CQs to patterns is a natural AI-assist task. Modular Ontology Modelling (MOMo; Shimizu, Hammar and Hitzler) [10] extends XD with schema diagrams and the CoModIDE tool.

### 1.6 SAMOD

SAMOD (Peroni, 2016) [11] is a lightweight, test-driven, iterative method. Each iteration produces a *test case*: a motivating scenario, informal CQs (each with an id, the question, the expected outcome, exemplar answers and dependencies on other CQs), a glossary of terms, a TBox, an exemplar ABox, and SPARQL queries. Three test types are run:

- **model test:** consistency and unit checks
- **data test:** the ABox is consistent with the TBox and covers the examples
- **query test:** the SPARQL queries return the expected results

The model then goes through merge and refactor steps, and the whole "bag of test cases" is re-run after each one. SAMOD is the closest existing fit for an AI platform: every artefact is small, structured and checkable.

### 1.7 OntoClean

OntoClean (Guarino and Welty, 2002) [12] validates taxonomies with four meta-properties:

- **Rigidity (+R, -R, ~R):** whether a property is essential to all of its instances
- **Identity (+I, +O):** whether the property carries or supplies an identity criterion
- **Unity (+U, -U, ~U):** whether instances are wholes, and under what unity criterion
- **Dependence (+D):** whether instances depend on something external

The constraints it checks include: an anti-rigid class cannot subsume a rigid one; a class with an identity criterion cannot be subsumed by one without it; an anti-unity class cannot subsume a unity class.

Typical violation: *Student* (a role, anti-rigid) placed above *Person* (rigid). For a standards platform this matters for roles such as Publisher, Maintainer and Steward, which are anti-rigid roles of rigid Agents. **Recommendation:** have the AI propose meta-property tags for every new class and flag constraint violations for a human to review. This is cheap and catches real modelling errors.

### 1.8 Kendall & McGuinness, *Ontology Engineering* (2019), and the OMG/EDM Council use-case approach

Kendall and McGuinness [13] describe a **use-case-driven** method grounded in their FIBO and OMG work. They argue that requirements should be captured as use cases using a template with these fields:

- name and identifier
- description and goals
- actors and stakeholders
- preconditions and triggers
- primary and alternate flows
- usage scenarios
- **competency questions with sample answers**
- resources and data sources
- non-functional requirements
- the vocabulary terms that emerge from the use case

They recommend scoping by business questions ("what does the business need to know?"). Practical interview questions include:

- Who are the users and what decisions do they make?
- What questions do they ask today, and where do the answers come from?
- What existing standards, glossaries and data models must be respected?
- What does "done" look like?

They also recommend **term excerption**: harvesting terms from regulations, glossaries and data dictionaries, then curating them into a term sheet with definitions and sources before formalising anything. FIBO's own process [14][15] layers this onto OMG's standards practice: domain teams write use cases and CQs, a term list goes through business review, then OWL is developed and tested in CI (see 4.6).

### 1.9 From CQs to OWL constructs to tests

| CQ pattern (example) | OWL construct | Test |
|---|---|---|
| "What kinds of X are there?" ("What types of dataset licence exist?") | Class hierarchy (`rdfs:subClassOf`), possibly `owl:disjointUnionOf` | SPARQL `SELECT ?c WHERE {?c rdfs:subClassOf* :Licence}` returns the expected set |
| "Which X has property P?" | Object or data property with domain and range | SPARQL over the exemplar ABox |
| "Every X must have exactly one Y" | `SubClassOf(X, ObjectExactCardinality(1 p Y))` (open-world; does not *validate* data) | Reasoner entailment test and a **SHACL** `sh:minCount 1; sh:maxCount 1` shape for data |
| "Can something be both X and Y?" (no) | `DisjointClasses(X Y)` | Error-provocation test: assert an individual in both classes and expect inconsistency |
| "What is an X?" (definitional) | `EquivalentClasses(X, G and some r F)` (genus-differentia) | DL query: the reasoner classifies test individuals as X |
| "Is A part of B?" (transitive) | `TransitiveObjectProperty`, property chains | Entailment check via `robot reason` then `robot query` |
| "Which X were valid at time t?" | Temporal pattern (an ODP such as TimeIndexedSituation) | SPARQL with FILTER over the ABox |

**Executable CQ tests.**

- **ROBOT `verify`** [16] runs SPARQL SELECT queries that return *violations*. Any result fails the build (with a non-zero exit code). Write positive CQs as "find expected-but-missing answers" queries, or use `robot query` with diffed expected outputs.
- **Themis** [7] lets you write CQ tests in a controlled language ("Dataset subclassOf Resource", "Dataset distribution some Distribution").
- **XD and SAMOD** pair each CQ with SPARQL and test data.
- **Recommendation:** store each CQ as `{id, text, priority, sparql, expected_results_file, fixture_abox, status}`. Run it in CI on the *reasoned* ontology (`robot reason --reasoner ELK` or `HermiT`, then `robot verify` or `robot query`).

---

## 2. Strict OWL best practice

### 2.1 Naming and identifiers

- **Pick one identifier policy.** Use either opaque IRIs (`odi:ODI_0000123`, the OBO style, which is language-independent and makes renames free) or readable CamelCase IRIs (`odi:DataLicence`, the schema.org, gist and FIBO style). Garijo and Poveda-Villalón discuss the trade-off [17]. For a multi-stakeholder hub where labels will be debated, opaque IRIs avoid "rename = breaking change". **Recommendation:** opaque IRIs with mandatory `rdfs:label` and `skos:prefLabel`.
- **Readable names.** If you use them: classes in UpperCamelCase and singular; properties in lowerCamelCase and verb-phrased (`hasPublisher`, `isPartOf`); no version numbers in term IRIs.
- **Labels.** Exactly one `rdfs:label` per language. The OBO "multiple labels" and "duplicate label" checks are ERROR level in ROBOT [18]. Labels should be lowercase except for proper nouns (OBO convention), have no leading or trailing whitespace, and be unique.

### 2.2 Annotations and definitions

- **Minimum per term:** `rdfs:label`, a textual definition (`skos:definition` or `IAO:0000115` "definition"), `dcterms:source` or `IAO:0000119` "definition source", and an editor note or `rdfs:comment` for scope.
- **Definitions use genus-differentia form** [19]: "An X is a G that D". Example: "A *data licence* is a *legal instrument* that grants permissions to use a dataset under stated conditions." Define every term this way, and where feasible mirror the text with an `owl:equivalentClass` logical definition (genus plus restrictions). ROBOT warns on "equivalent class axiom no genus".
- **Avoid:** circular definitions, definitions that only restate the label, and definitions with "and/or". Seppälä, Ruttenberg and Smith's guidelines [19] are the reference.

### 2.3 Reuse

- **MIREOT** (Minimum Information to Reference an External Ontology Term; Courtot and others, 2011) [20]: import only the term IRI, its label, its definition and its parent. In practice, use `robot extract --method MIREOT`, or the SLME modules (`--method BOT/STAR/TOP`) when logical axioms are needed.
- **`owl:imports`:** imports pull in the full closure, along with that ontology's reasoning cost and its versioning risk. Pin imports to a **versionIRI**, not the version-free IRI, so your release is reproducible. ODK automates import modules and their refresh [21].
- **Upper-ontology alignment.** BFO (ISO/IEC 21838-2) is mandatory in OBO practice. **gist** (Semantic Arts) is a minimalist enterprise upper ontology: about 140 classes, OWL 2 DL, and about 12 major versions [22]. schema.org is used for web discoverability, often via `rdfs:seeAlso` or SKOS mappings instead of hard `subClassOf`, because schema.org's semantics are deliberately loose. **Recommendation for ODI:** align to DCAT 3, DCTERMS, PROV-O, ODRL, SKOS and ORG as the primary reuse set (ODI's domain is data publication and licensing). Choose one upper ontology (gist or BFO), and keep schema.org as mappings only.

### 2.4 OWL 2 profiles

OWL 2 defines three profiles [23]:

- **EL:** polynomial-time classification, suits large taxonomies, reasoned with ELK
- **QL:** query rewriting to SQL, for OBDA
- **RL:** rule-based, implementable in triplestores

OWL 2 DL is the decidable superset. Decide the target profile in the ORSD and enforce it with `robot validate-profile --profile DL|EL`. Winstanley notes the practical point that a triplestore's reasoner, such as RDFox, may need a profile that forces axioms to be pruned from a richer upper ontology [22].

### 2.5 Consistency and coherence

- **Consistency** means the ontology has a model. **Coherence** means no named class is unsatisfiable (equivalent to `owl:Nothing`).
- **Reasoners:**
  - **HermiT** (hypertableau, complete for OWL 2 DL)
  - **Pellet/Openllet** (complete for DL, gives explanations)
  - **ELK** (EL only, very fast, incomplete outside EL)
  - **Whelk** (EL plus rules, used in ODK)
- **CI gate:** `robot reason --reasoner HermiT --equivalent-classes-allowed asserted-only --exclude-tautologies structural`. This fails on unsatisfiable classes, and the `--equivalent-classes-allowed` option catches *inferred* equivalences between named classes, which usually indicate modelling errors. Run `robot explain` to produce justifications of an unsatisfiability for the human reviewer [24].
- **Tests:** keep a set of **negative test fixtures** (error provocation, in XD terms) that *must* be inconsistent. They prove that the disjointness and cardinality axioms bite.

### 2.6 Quality scanners

- **OOPS! (OntOlogy Pitfall Scanner!)** [25] reports 41 catalogued pitfalls, rated critical, important or minor. Examples: P05 wrong inverse relationships; P06 cycles in the hierarchy; P08 missing annotations; P10 missing disjointness; P11 missing domain or range; P19 multiple domains or ranges (interpreted as an intersection); P41 no licence. It is available as a REST API.
- **ROBOT `report`** [18] runs 32 SPARQL checks. ERROR level, which fails the release by default, includes: missing label, multiple labels, duplicate label, duplicate or multiple definitions, missing ontology title/description/licence, deprecated class or property reference, misused `replaced_by`, misused obsolete label, and illegal use of built-in vocabulary. WARN level includes: missing definition, annotation whitespace, equivalent pair, and invalid entity URI. Use `--profile` to customise levels and add local queries. Use `--fail-on warn` once the ontology is clean.

### 2.7 SHACL for data shapes

OWL is open-world and has no unique-name assumption, so it cannot *validate* that a dataset record has a licence. SHACL (W3C Recommendation, 2017) [26] can. Publish an `odi-shapes.ttl` alongside each ontology, with `sh:NodeShape` per class and `sh:minCount`, `sh:datatype`, `sh:class` and `sh:in` constraints derived from the CQs and cardinality requirements. Test it with pySHACL or TopBraid against conforming and non-conforming fixtures. Version the shapes in lock-step with the ontology, because a SHACL tightening is a breaking change for data publishers (see 4.4).

---

## 3. FAIR applied to ontologies

### 3.1 Garijo & Poveda-Villalón best practices

Their best practices for FAIR vocabularies [17] are:

1. Use a namespace URI under your control.
2. Use a short prefix that does not collide with existing ones (check prefix.cc, LOV and BioPortal).
3. Choose hash or slash namespaces deliberately.
4. Consider opaque IDs.
5. **Use semantic versioning, and keep the version out of the ontology URI** (`owl:versionIRI`, `owl:versionInfo`, `owl:priorVersion`).
6. Use a permanent IRI service (w3id.org or purl.org).
7. Provide rich metadata (licence, CC-BY recommended; creator; contributor; created; title; description; bibliographic citation; preferred prefix and namespace; versionIRI; priorVersion).
8. Give every term a label and a definition.
9. Generate HTML documentation (WIDOCO).
10. Provide diagrams.
11. Serve multiple serialisations via 303 content negotiation, with Turtle as the default.
12. Register the vocabulary (prefix.cc, LOV, FAIRsharing, a domain portal) and embed JSON-LD in its documentation.
13. Use end-to-end frameworks (OnToology, VoCol).

### 3.2 FOOPS! checks

FOOPS! [27][28] (Garijo, Corcho and Poveda-Villalón, ISWC 2021) scores ontologies against 24 tests:

| Group | Checks |
|---|---|
| Findable | PURL1 (persistent URL), URI1 (URI resolves), URI2 (consistent IDs), VER1 (versionIRI declared), VER2 (versionIRI resolves), OM1 (minimum metadata), FIND1 (prefix declared), FIND2 (prefix in prefix.cc or LOV), FIND3 (in a community registry) |
| Accessible | CN1 (content negotiation for RDF), HTTP1 (open protocol), FIND_3_BIS (metadata accessible even if the ontology is not) |
| Interoperable | RDF1 (available in RDF), VOC1 (reuses metadata vocabularies), VOC2 (imports or reuses established vocabularies) |
| Reusable | DOC1 (HTML documentation), OM2 (recommended metadata), OM3 (detailed metadata), OM4.1 and OM4.2 (licence present and resolvable), OM5.1 and OM5.2 (basic and detailed provenance), VOC3 (all terms labelled), VOC4 (all terms defined) |

**Recommendation:** run FOOPS! (REST API or JAR) on every release candidate and block publication below a threshold, for example 100% of the F and R1.1 checks.

### 3.3 Required ontology header (minimum for Concord)

```turtle
<https://w3id.org/odi/ont/licensing> a owl:Ontology ;
  owl:versionIRI <https://w3id.org/odi/ont/licensing/2.1.0> ;
  owl:versionInfo "2.1.0" ;
  owl:priorVersion <https://w3id.org/odi/ont/licensing/2.0.3> ;
  owl:backwardCompatibleWith <https://w3id.org/odi/ont/licensing/2.0.3> ;
  dcterms:title "ODI Licensing Ontology"@en ;
  dcterms:description "..."@en ;
  dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
  dcterms:creator <https://orcid.org/...> ; dcterms:contributor ... ;
  dcterms:publisher <https://theodi.org/> ;
  dcterms:created "2026-01-10"^^xsd:date ; dcterms:modified "2026-10-01"^^xsd:date ;
  dcterms:bibliographicCitation "..." ;
  vann:preferredNamespacePrefix "odil" ;
  vann:preferredNamespaceUri "https://w3id.org/odi/ont/licensing#" ;
  bibo:status <http://purl.org/ontology/bibo/status/published> ;
  mod:competencyQuestion "..." ;   # MOD 3.0
  dcat:landingPage <...> ; foaf:logo <...> .
```

**MOD** (Metadata for Ontology Description and Publication, now at 3.0, `https://w3id.org/mod`) [29] is the RDA, FAIR-IMPACT and OntoPortal consensus vocabulary for semantic-artefact metadata. It aligns the DCTERMS, DCAT, VOAF, OMV and PAV properties, and adds artefact-specific fields such as `mod:competencyQuestion`, `mod:designedForTask` and `mod:hasFormalityLevel`. FAIR-IMPACT's specification of shared metadata for semantic-artefact catalogues [30] builds on it.

### 3.4 Persistent IRIs

**w3id.org** [31] is a community-run, GitHub-managed redirect service. A pull request to `perma-id/w3id.org` adds an `.htaccess` file under `/odi/`. Set up:

- content negotiation (`text/turtle`, `application/rdf+xml`, `application/ld+json`, falling back to HTML)
- a version-free IRI redirecting to the latest release
- version IRIs redirecting to immutable release files

OBO uses purl.obolibrary.org with the same pattern, and dated version IRIs are preferred there [32]. **Rule:** release files at a versionIRI never change, and fixes go in a new release [32].

---

## 4. Versioning and maintenance

### 4.1 OWL 2 versioning vocabulary

OWL 2 [33] gives you:

- **`owl:versionIRI`:** identifies a specific version. An ontology document may be retrieved by either its ontology IRI (the latest version) or its version IRI.
- **`owl:versionInfo`:** a human-readable version string.
- **`owl:priorVersion`:** points to the previous version.
- **`owl:backwardCompatibleWith`:** this version can replace the named version without breaking users. The spec intends this to mean that all identifiers keep their meaning.
- **`owl:incompatibleWith`:** this version is explicitly not backward compatible.
- **`owl:DeprecatedClass`, `owl:DeprecatedProperty` and `owl:deprecated true`:** mark terms kept only for compatibility.

The OWL semantics give none of these properties any logical meaning: they are annotations. **The platform must give them meaning by computing them** (see 4.4).

### 4.2 Peter Winstanley's work on versioning

Peter Winstanley is an ontologist at **Semantic Arts**, based in Scotland. He previously worked as an interoperability specialist in Scottish and UK Government linked-data groups and the EC Joinup semantic interoperability community. He was a contributor to W3C *Data on the Web Best Practices*, an editor of **W3C DCAT 2**, and **co-chair of the W3C Dataset Exchange Working Group (DXWG)** [34]. The research found no single dedicated 2024–2026 paper or blog post by him on ontology versioning. His versioning contributions are in DXWG and in his Semantic Arts and gist work:

- **DXWG versioning work (DCAT 3, 2020–2022).** DXWG ran a versioning sprint (ACTION-416, owned by Riccardo Albertoni; preparatory wiki page "Material for a SPRINT on Versioning") [35]. In the DCAT subgroup meeting of 3 June 2020 [36], Winstanley:
  - noted that "in DCAT we used cardinal numbers for versions rather than the 3 decimal 'semantic versioning'"
  - asked whether the version object should be a string or an entity, and how the work fits with **PAV and PROV-O**
  - said normative versioning text needs "good socialisation and community discussion before decisions"
  - argued that **status values must be restricted to a small set**: otherwise "we will end up with something similar to the situation with licenses"
  - argued that a predicate so flexible that it has no defined meaning is pointless
  - argued that "the full life cycle of data needs to be able to be handled", with links to lineage and workflow descriptions

  In the 22 September 2020 DXWG plenary [37] he flagged the scoping problem ("if you take the simple route, there's not a lot to say about it, otherwise it takes up a lot of the space of the rec"). He suggested deciding what goes in the Recommendation and what goes in primers, and pointed to PROV-based status vocabularies. These positions shaped DCAT 3's versioning section [38], which uses `dcat:version`, `dcat:previousVersion`, `dcat:hasCurrentVersion`, `dcat:hasVersion`, `adms:status` and `adms:versionNotes`, and reuses PAV and PROV.
- **gist and Semantic Arts.** His ISKO-UK 2023 paper *Is an Upper Ontology Useful?* (CEUR Vol-3661) [22] reports that gist has gone through "12 versions" while staying at about 140 classes and 1,500–1,700 axioms. It argues that upper ontologies bring consistency through disjointness and integration benefits, but can clash with the OWL profiles that triplestores support. gist's published policy [39][40] is **SemVer adapted for ontologies**:
  - **major:** breaking, roughly annual
  - **minor:** backward-compatible additions of classes and properties, one or two per major
  - **patch:** bug fixes, documentation and infrastructure

  Minor and patch upgrades require only changing the version in your import statement. Every major release ships SPARQL **migration queries** (run with `onto_tool`) that rewrite data, ontologies and SHACL. Deleted or modified terms are not auto-fixed: the queries *report their usage*. Some changes, such as a property replaced by its inverse, need manual work. Winstanley has presented gist publicly, for example to the Digital Twin Hub [41].
- **Takeaways for the ODI platform:**
  - constrain version status to a small controlled list (draft, candidate, stable, deprecated, withdrawn)
  - model version lineage with PROV, PAV and DCAT 3, not ad hoc strings
  - make SemVer meaningful by shipping migration SPARQL with every major release

### 4.3 Other release processes

- **OBO Foundry and ODK.**
  - **Principle 4** [32]: every release has a resolvable versionIRI containing the version string, preferably dated (`.../obo/xx/releases/2026-10-01/xx.owl`), and released files are immutable.
  - **Principle 13** [42]: changes must be announced.
  - **Principle 19** [43]: a term's definition must keep denoting the same referents. Substantial changes need a *new term*, and only clarifications are allowed in place. Obsoletion requires `owl:deprecated true`, the "obsolete " label prefix, removing all logical axioms and all usages, and keeping the definition. It recommends `IAO:0100001` (term replaced by) and `oboInOwl:consider`.
  - The **ODK** [21] standardises the release pipeline (`sh run.sh make prepare_release`): import refresh, reasoning, the ROBOT report, release artefacts (base, full, simple, non-classified) and a GitHub release.
- **Gene Ontology** [44]. Before obsoleting a term, editors check annotation usage and logical-definition usage. They email the affected groups with the reason, the annotation counts and a GitHub ticket, setting an objection deadline (lazy consensus). Then they deprecate (`owl:deprecated`, remove the equivalence and subclass axioms, prefix the label "obsolete " and the definition "OBSOLETE.") and add `replaced_by` or `consider`.
- **FIBO and EDM Council** [14][15]. Maturity is set per ontology:
  - **Release:** extensively unit- and integration-tested
  - **Provisional:** work in progress
  - **Informative:** rejected, kept only for references

  FIBO publishes two editions: **Production** (Release only) and **Development** (all levels). Every push to a contributor fork runs Jenkins "hygiene" tests (strict for Production, lax for Development), and a serializer normalises the RDF. Changes arrive as pull requests reviewed by the FIBO Community Group, and releases are quarterly, labelled e.g. `2026Q3`. FIBO also flows into OMG specifications (EDMC-FIBO) through OMG's RFC and finalisation-task-force process.
- **schema.org** [45]. Named releases every few weeks. Proposals go into a **pending** area (additive, may change). The webmaster prepares a release candidate from rough consensus, and the **steering group must approve it unanimously**. It is published if there are no concerns within 10 business days. Terms are rarely removed: they are marked `schema:supersededBy`. Dated snapshots and `schemaVersion` serve consumers who need precision.
- **W3C** [46][47]. Recommendations follow the Process Document: WD → CR (wide review) → PR → REC, then *candidate and proposed amendments* for maintenance. W3C namespace policy allows only limited changes to a REC vocabulary's namespace document, essentially clarifications, errata and *additions that don't change existing meaning*. Meaning changes need a new Recommendation track (DCAT 2 → 3 kept the `dcat:` namespace and added terms).

### 4.4 Rule table: classifying a change as PATCH, MINOR or MAJOR

Principle: a change is **MAJOR** if a consumer who updates may get *different or fewer answers, new inconsistencies, or broken references*. It is **MINOR** if it adds entailments or terms without retracting any previous entailment about existing terms. It is **PATCH** if the logical content (the axiom set, ignoring annotations that aren't load-bearing) is unchanged.

These rules synthesise OWL 2 semantics [33], OBO principle 19 [43], the gist policy [39] and the SemVer convention in [17]. They are written so that they can be computed from `robot diff`, a reasoner and the CQ tests.

| # | Change detected | Class | Detection method |
|---|---|---|---|
| P1 | Typo or spelling fix in `rdfs:label`, `skos:altLabel` or synonym, where the meaning is unchanged | PATCH | `robot diff`: annotation-only delta |
| P2 | Definition reworded for clarity, referents unchanged (OBO P19 "minor edit") | PATCH (human attests "same referents") | Annotation delta on a definition property, plus reviewer checkbox |
| P3 | Adding or changing `rdfs:comment`, `skos:example`, editor notes, `dcterms:source`, translations (new language labels) | PATCH | Annotation-only delta |
| P4 | Ontology-header metadata changes (contributors, description, `dcterms:modified`) | PATCH | Header delta |
| P5 | Build or serialisation changes with no axiom delta | PATCH | `robot diff` empty |
| P6 | Fixing a term that was *documented* but whose axiom was a clear bug, where the fix restores documented intent and no CQ result changes | PATCH (needs reviewer sign-off; otherwise MINOR) | CQ suite unchanged |
| m1 | New class, property or individual with a new IRI | MINOR | New declaration axioms |
| m2 | New axiom whose signature mentions **only new terms**, or that relates new terms beneath existing ones (new subclass of an existing class) | MINOR | Signature analysis of added axioms |
| m3 | New `owl:deprecated true` on a term **with** `IAO:0100001` replaced-by or `oboInOwl:consider`, where the term is kept with its label and definition | MINOR (announce; removal comes later as MAJOR) | `deprecated_class` diff and ROBOT `misused replaced by` check |
| m4 | New mapping or alignment annotation (`skos:exactMatch`, `rdfs:seeAlso`) | MINOR | Annotation delta on mapping properties |
| m5 | New subproperty or superproperty, domain or range on a *new* property | MINOR | — |
| m6 | Import of a new module that adds entailments but introduces **no new unsatisfiable classes** and changes no classification of existing terms | MINOR | Reasoned diff of the subsumption hierarchy restricted to the old signature is empty |
| m7 | New *optional* SHACL property shape (`sh:minCount 0`) or relaxed constraint | MINOR | SHACL diff |
| M1 | Removal of any declared term (IRI no longer declared), or a rename of an IRI | MAJOR (forbidden for released terms: obsolete instead) | Declarations removed |
| M2 | Removal of any logical axiom about an existing term (subClassOf, equivalence, domain, range, characteristic, disjointness) | MAJOR | Axiom removed whose signature ⊆ old signature |
| M3 | **New logical axiom about existing terms** that changes entailments over the old signature: a new existing-to-existing subclass, new disjointness, new domain or range on an existing property, tightened cardinality, a property made functional or transitive | MAJOR (may newly entail inconsistency or reclassify user data) | Reasoned diff: the set of entailed atomic subsumptions and property assertions over the old signature differs, or a test ABox becomes inconsistent |
| M4 | Change to a term's referents (definition substantively changed, OBO P19) | MAJOR, *and* must mint a new term instead (old term obsoleted) | Reviewer attests; AI flags large semantic delta in definitions |
| M5 | Final removal of a previously deprecated term, or removal of its label or definition | MAJOR | — |
| M6 | Change of datatype on an existing data property's range, or a property moved between object and data property | MAJOR | — |
| M7 | Bumping a pinned import to a version that is itself MAJOR, or any import change that alters classification of the old signature | MAJOR | Reasoned diff after import swap |
| M8 | Any CQ test that passed in the prior version now fails, or returns a different answer set | MAJOR (unless the CQ was formally retired in the ORSD) | CQ suite run against the old and new versions |
| M9 | Tightened SHACL constraint (raised `sh:minCount`, new `sh:in`, new required shape) | MAJOR for the shapes artefact | SHACL diff and old-fixture regression |
| M10 | Change of namespace, prefix or ontology IRI, or a profile downgrade (DL becomes non-DL, EL becomes non-EL) | MAJOR | `robot validate-profile` |
| X | Any change that makes the ontology **inconsistent or adds an unsatisfiable class** | REJECT (cannot be released) | `robot reason` |

**How the highest-ranked rule wins.** Version bump = max(class) over all detected changes.

- MAJOR → set `owl:incompatibleWith <prior>`.
- MINOR or PATCH → set `owl:backwardCompatibleWith <prior>`.
- Always set `owl:priorVersion`.

**Note on M3.** Strictly, in monotonic OWL *any* added axiom about existing terms can add entailments, and new entailments can turn a user's data inconsistent. Some projects (for example OBO, in practice) treat new existing-to-existing subclass links as minor. **Recommendation:** classify as MINOR only when the reasoned diff over the old signature shows *added* atomic subsumptions and no new disjointness, cardinality or characteristic, and the regression ABoxes stay consistent. Otherwise classify as MAJOR. Make this a configurable policy flag.

**Deprecation lifecycle.**

1. Deprecate in a MINOR release, with replaced-by or consider, an announcement and an issue link.
2. Keep the term for at least one further MINOR release, or N months (GO and OBO use a comment period).
3. Remove only in a MAJOR release, if ever. Under OBO policy, deprecated terms are never deleted; only their axioms are stripped.

### 4.5 Tooling for automated breaking-change detection

- **`robot diff`** [48] compares two ontologies semantically, ignoring serialisation. It outputs plain, pretty, HTML or Markdown (in Manchester syntax). It is the axiom-level input to the rule table. For *entailment-level* diffs, run `robot reason` and `robot relax` on both sides first, or diff the inferred class hierarchies.
- **Bubastis** (EBI SPOT) [49] gives class-level diffs (new, deleted or changed classes) and is used for EFO and OLS change reports.
- **ecco** (Gonçalves, Parsia and Sattler) [50] diffs the *entailments* between OWL 2 ontologies and categorises them: effectual or ineffectual, strengthened or weakened, new, retired. This is exactly the MINOR versus MAJOR test in M3.
- **OWL Diff / ContentCVS**, and older version-control work such as SVoNt [51], are historical references.
- **Recent work (2023–2026):**
  - **KGCL, the Knowledge Graph Change Language** (Hegde, Vendetti, Matentzoglu, Overton, Musen, Mungall and others, arXiv 2409.13906, 2024) [52]. A data model and controlled natural language for change requests and diffs, such as "obsolete X with replacement Y". It comes with a GitHub agent that applies changes and BioPortal change-request integration. KGCL is an ideal *change-proposal format* for an AI platform: an LLM drafts KGCL, a human approves, and the tooling applies it.
  - **OM4OV** (Qiang, Taylor and Wang, 2024–2025, TGDK) [53]. Treats version diffing as ontology matching, using LLM agents (Agent-OV). It finds that naive matching inflates scores and detects *updated* entities poorly, and proposes cross-referencing previous alignments.
  - **Survey:** "On the Evolution of Knowledge Graphs" (arXiv 2310.04835) [54].
  - The **ESWC 2026 LLMs4KGOE workshop** (LLM-driven KG and ontology engineering, with human-in-the-loop) [55] is the current venue for AI-assisted ontology engineering.
- **Recommendation:** pipeline = `robot diff` (axioms) + ecco or reasoned-hierarchy diff (entailments) + CQ regression + SHACL fixture regression → rule engine (4.4) → proposed version number + changelog in KGCL + auto-generated migration SPARQL (the gist pattern) for MAJOR releases.

---

## 5. Governance

### 5.1 Reference models

| Body | Who decides | Mechanism | Notes |
|---|---|---|---|
| **OBO Foundry** [56] | Operations Committee | Consensus on calls (no strenuous objection), no quorum. **Lazy consensus**: status changes are enacted after 4 weeks without objection, and metadata PRs are merged after 4 weeks | Individual ontologies govern their own editors; GO uses editor review plus a user objection window [44] |
| **FIBO / EDM Council** [14][15] | FIBO Community Group, with domain content teams and a leadership/steering team | GitHub PRs, automated hygiene tests gate Production; maturity promotion (Provisional → Release) after review and testing; quarterly releases; OMG adoption for formal standardisation | Separation of Production and Development editions is a strong pattern |
| **schema.org** [45] | Steering group and webmaster | Community discussion in the W3C CG and GitHub → webmaster's release candidate from rough consensus → **unanimous** steering-group approval → 10-business-day objection window | "Pending" sandbox for unreviewed additive terms |
| **W3C** [46] | Working Group, with Director/Team and AC review | Consensus (CfC = call for consensus, often lazy), formal objections escalated to a Council; mandatory wide review and implementation evidence before REC | Strongest stability guarantees |
| **IETF** [57] | WG chairs judge **rough consensus** (RFC 7282): objections must be *addressed*, not out-voted; "we reject kings, presidents and voting" | Humming, chair judgement, appeal path | Good model for definitional disputes |
| **Apache** [58] | PMC (binding votes) | +1 / 0 / -1. Code changes: a -1 is a **veto** that must carry a justification. Releases: **majority with at least 3 binding +1s, and more +1 than -1**; lazy consensus (72 h) for routine decisions | Clear, mechanical thresholds |

### 5.2 Roles

- **Owner/Sponsor:** accountable organisation (ODI), holds licence and IRI space.
- **Steward/Maintainer:** per ontology. Owns the roadmap, cuts releases, has the final technical say (like an OBO ontology lead or an Apache PMC member).
- **Editor:** writes changes and has merge rights after review.
- **Reviewer:** domain or modelling expert who signs off PRs. Ideally distinct from the editor (the four-eyes rule).
- **Contributor:** proposes changes through issues or KGCL.
- **AI agent:** a *contributor* only. It drafts CQs, axioms, definitions, OntoClean tags, KGCL changes and changelogs, and never holds approval rights. (Recommendation, consistent with LLMs4KGOE's human-in-the-loop emphasis [55].)

### 5.3 Proposed decision rules for Concord (Recommendation)

| Change class (4.4) | Approval | Window | Escalation |
|---|---|---|---|
| PATCH | 1 reviewer approval + green CI (reasoner, ROBOT report, FOOPS!, CQs) | none (merge on approval) | — |
| MINOR | 2 approvals (≥1 steward) + green CI; **lazy consensus**: announced to the group | 7 days without sustained objection | An objection moves it to MAJOR handling |
| Deprecation (m3) | As MINOR + announcement listing known users (GO pattern) | 14–28 days (OBO uses 4 weeks) | Steward rules |
| MAJOR | Steward proposal + migration notes and SPARQL + **vote: ≥3 binding +1, more +1 than −1, no unresolved steward −1 with justification** (Apache release rule) | 14 days; must be addressed in the IETF rough-consensus sense | Owner/steering board makes the final call |
| New ontology into the hub | ORSD + CQ suite + FOOPS! threshold + review by a designated reviewer (OBO NOR pattern) | Consensus on governance call | Steering board |

Every decision is recorded in the PR or issue (W3C and schema.org publish their decisions as minutes). The release notes should be generated from KGCL plus `robot diff --format markdown`.

---

## 6. Implementation checklist (platform CI)

1. ORSD and CQ objects present and up to date (NeOn/LOT).
2. `robot validate-profile --profile DL` (or EL).
3. `robot reason --reasoner HermiT` (ELK for EL), with no unsatisfiable classes and no inferred named-class equivalences.
4. Negative fixtures are inconsistent; positive fixtures are consistent.
5. `robot report --fail-on error` (later `warn`), with an ODI profile.
6. OOPS! API: no *critical* pitfalls.
7. CQ suite: `robot verify` and `robot query` on the reasoned ontology; SHACL fixtures via pySHACL.
8. `robot diff` + entailment diff → rule table → version number + `owl:priorVersion` / `backwardCompatibleWith` / `incompatibleWith`.
9. FOOPS! score gate; WIDOCO documentation; w3id redirects; immutable versioned artefacts; MOD 3.0 header.
10. Governance gate per 5.3, with KGCL changelog and announcements.

---

## References

1. Grüninger, M. & Fox, M. S. (1995). Methodology for the Design and Evaluation of Ontologies. IJCAI Workshop on Basic Ontological Issues in Knowledge Sharing. http://www.eil.utoronto.ca/wp-content/uploads/enterprise-modelling/papers/gruninger-ijcai95.pdf
2. Uschold, M. & Gruninger, M. (1996). Ontologies: Principles, Methods and Applications. *Knowledge Engineering Review* 11(2). https://doi.org/10.1017/S0269888900007797
3. Fernández-López, M., Gómez-Pérez, A. & Juristo, N. (1997). METHONTOLOGY: From Ontological Art Towards Ontological Engineering. AAAI Spring Symposium. https://oa.upm.es/5484/
4. Suárez-Figueroa, M. C., Gómez-Pérez, A. & Fernández-López, M. (2012/2015). The NeOn Methodology framework. *Applied Ontology* 10(2). https://doi.org/10.3233/AO-150145
5. Suárez-Figueroa, M. C., Gómez-Pérez, A. & Villazón-Terrazas, B. (2009). How to Write and Use the Ontology Requirements Specification Document. ODBASE/OTM. https://doi.org/10.1007/978-3-642-05151-7_16
6. Poveda-Villalón, M., Fernández-Izquierdo, A., Fernández-López, M. & García-Castro, R. (2022). LOT: An industrial oriented ontology engineering framework. *Engineering Applications of AI* 111:104755. https://doi.org/10.1016/j.engappai.2022.104755 ; https://lot.linkeddata.es/
7. Fernández-Izquierdo, A. & García-Castro, R. Themis: a tool for validating ontologies through requirements. https://themis.linkeddata.es/
8. Presutti, V. et al. (2012). Pattern-Based Ontology Design (eXtreme Design). In *Ontology Engineering in a Networked World*, Springer. https://doi.org/10.1007/978-3-642-24794-1_3
9. Ontology Design Patterns portal. http://ontologydesignpatterns.org/
10. Shimizu, C., Hammar, K. & Hitzler, P. (2023). Modular ontology modeling. *Semantic Web* 14(3). https://doi.org/10.3233/SW-222886
11. Peroni, S. (2016). SAMOD: an agile methodology for the development of ontologies. OWLED. https://essepuntato.it/samod/ ; https://essepuntato.it/papers/samod-owled2016.html
12. Guarino, N. & Welty, C. (2002). Evaluating ontological decisions with OntoClean. *CACM* 45(2). https://doi.org/10.1145/503124.503150
13. Kendall, E. F. & McGuinness, D. L. (2019). *Ontology Engineering*. Morgan & Claypool, Synthesis Lectures on the Semantic Web. https://doi.org/10.2200/S00834ED1V01Y201802WBE018
14. EDM Council. FIBO Development Process. https://spec.edmcouncil.org/fibo/page/development-process
15. EDM Council. FIBO Primer and specification. https://spec.edmcouncil.org/fibo/doc/FIBO_Primer.pdf ; https://spec.edmcouncil.org/fibo/ ; maturity discussion https://github.com/edmcouncil/fibo/discussions/1373
16. ROBOT verify. https://robot.obolibrary.org/verify
17. Garijo, D. & Poveda-Villalón, M. (2020). Best Practices for Implementing FAIR Vocabularies and Ontologies on the Web. arXiv:2003.13084. https://arxiv.org/abs/2003.13084
18. ROBOT report and report queries. https://robot.obolibrary.org/report ; https://robot.obolibrary.org/report_queries/
19. Seppälä, S., Ruttenberg, A. & Smith, B. (2017). Guidelines for writing definitions in ontologies. *Ciência da Informação* 46(1). https://philpapers.org/rec/SEPGFW
20. Courtot, M. et al. (2011). MIREOT: the Minimum Information to Reference an External Ontology Term. *Applied Ontology* 6(1). https://doi.org/10.3233/AO-2011-0087
21. Ontology Development Kit (ODK). https://github.com/INCATools/ontology-development-kit ; docs https://ontology-development-kit.readthedocs.io/
22. Winstanley, P. (2023). Is an Upper Ontology Useful? ISKO-UK 2023, CEUR Vol-3661. https://ceur-ws.org/Vol-3661/10-SHORT-PWinstanley-ISKOUK2023.pdf
23. W3C (2012). OWL 2 Web Ontology Language Profiles (2nd ed.). https://www.w3.org/TR/owl2-profiles/
24. ROBOT reason and explain. https://robot.obolibrary.org/reason ; https://robot.obolibrary.org/explain
25. Poveda-Villalón, M., Gómez-Pérez, A. & Suárez-Figueroa, M. C. (2014). OOPS! (OntOlogy Pitfall Scanner!). *IJSWIS* 10(2). https://oops.linkeddata.es/ ; catalogue https://oops.linkeddata.es/catalogue.jsp
26. W3C (2017). Shapes Constraint Language (SHACL). https://www.w3.org/TR/shacl/
27. Garijo, D., Corcho, O. & Poveda-Villalón, M. (2021). FOOPS!: An Ontology Pitfall Scanner for the FAIR Principles. ISWC Posters & Demos, CEUR Vol-2980. http://ceur-ws.org/Vol-2980/paper321.pdf ; https://github.com/oeg-upm/fair_ontologies
28. FOOPS! test catalogue. https://oeg-upm.github.io/fair_ontologies/doc/catalog.html (via https://w3id.org/foops/catalog)
29. MOD: Metadata for Ontology Description and Publication, v3.0. https://w3id.org/mod/3.0 ; RDA MSC entry https://rdamsc.bath.ac.uk/msc/m129
30. FAIR-IMPACT D4.3 Specification of shared metadata description of semantic artefacts and their catalogues (2024). https://zenodo.org/records/12579779
31. w3id.org Permanent Identifiers for the Web. https://w3id.org/ ; https://github.com/perma-id/w3id.org
32. OBO Foundry Principle 4: Versioning. http://obofoundry.org/principles/fp-004-versioning.html
33. W3C (2012). OWL 2 Structural Specification §3.3 Versioning; OWL 2 Primer. https://www.w3.org/TR/owl2-syntax/#Ontology_IRI_and_Version_IRI ; https://www.w3.org/TR/owl2-primer/
34. Knowledge Graph Conference speaker bio: Peter Winstanley. https://www.knowledgegraph.tech/blog/speakers/peter-winstanley/
35. W3C DXWG ACTION-416 (versioning straw man). https://www.w3.org/2017/dxwg/track/actions/416 ; https://github.com/w3c/dxwg/wiki/Material-for-a-SPRINT-on-Versioning
36. W3C DXWG DCAT subgroup minutes, 3 June 2020. https://www.w3.org/2020/06/03-dxwgdcat-minutes
37. W3C DXWG plenary minutes, 22 September 2020. https://www.w3.org/2020/09/22-dxwg-minutes
38. W3C (2024). Data Catalog Vocabulary (DCAT) Version 3, §Versioning. https://www.w3.org/TR/vocab-dcat-3/#dataset-versions
39. Semantic Arts. gist repository (versioning policy in README). https://github.com/semanticarts/gist
40. Semantic Arts. gist Major Version Migration. https://github.com/semanticarts/gist/blob/develop/docs/MajorVersionMigration.md
41. Digital Twin Hub. Peter Winstanley of Semantic Arts presents the 'gist' Core Ontology. https://digitaltwinhub.co.uk/download/peter-winstanley-of-semantic-arts-presents-the-gist-core-ontology/
42. OBO Foundry Principle 13: Notification of Changes. https://obofoundry.org/principles/fp-013-notification.html
43. OBO Foundry Principle 19: Stability of Term Meaning. https://obofoundry.org/principles/fp-019-term-stability.html
44. Gene Ontology. Obsoleting an Existing Ontology Term. https://go-ontology.readthedocs.io/en/stable/ObsoleteTerm.html
45. schema.org. How we work. https://schema.org/docs/howwework.html
46. W3C Process Document. https://www.w3.org/policies/process/
47. W3C URIs for W3C Namespaces (namespace change policy). https://www.w3.org/2005/07/13-nsuri
48. ROBOT diff. https://robot.obolibrary.org/diff
49. EBI SPOT Bubastis. https://github.com/EBISPOT/bubastis
50. Gonçalves, R. S., Parsia, B. & Sattler, U. (2012). Ecco: A hybrid diff tool for OWL 2 ontologies. OWLED. https://www.aminer.org/pub/53e999f5b7602d970223b2ed/comparing-ontologies-with-ecco ; categorisation paper https://www.researchgate.net/publication/221613850_Categorising_logical_differences_between_OWL_ontologies
51. Luczak-Rösch, M. et al. SVoNt – Version Control of OWL Ontologies on the Concept Level. https://www.researchgate.net/publication/221384709_SVoNt_-_Version_Control_of_OWL_Ontologies_on_the_Concept_Level
52. Hegde, H. et al. (2024). A Change Language for Ontologies and Knowledge Graphs (KGCL). arXiv:2409.13906. https://arxiv.org/abs/2409.13906 ; https://w3id.org/kgcl/
53. Qiang, Z., Taylor, K. & Wang, W. OM4OV: Leveraging Ontology Matching for Ontology Versioning. arXiv:2409.20302. https://arxiv.org/abs/2409.20302
54. On the Evolution of Knowledge Graphs: A Survey and Perspective (2023). arXiv:2310.04835. https://arxiv.org/abs/2310.04835
55. LLMs4KGOE 2026 workshop CFP (ESWC 2026), semantic-web mailing list. https://lists.w3.org/Archives/Public/semantic-web/2026Mar/0012.html
56. OBO Foundry Standard Operating Procedures; Operations Committee. https://obofoundry.org/docs/SOP.html ; https://obofoundry.org/docs/OperationsCommittee.html
57. Resnick, P. (2014). RFC 7282: On Consensus and Humming in the IETF. https://www.rfc-editor.org/rfc/rfc7282
58. Apache Software Foundation. Voting. https://apache.org/foundation/voting ; How Apache projects use consensus https://community.apache.org/blog/how_apache_projects_use_consensus.html
