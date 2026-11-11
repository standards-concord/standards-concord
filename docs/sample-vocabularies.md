# Solid ecosystem sample standards

In demo mode Concord includes nine sample copies of vocabularies used by SolidOS. Open **Sample standards** on the home page. The copies let people explore terms and try the deliberation process; the linked publisher remains authoritative. Version 1.0.0 is Concord's converted copy, not a new upstream release. Only Priya Shah owns and stewards the samples. Other signed-in people can propose changes through the usual review process.

The sample section is collapsed initially and follows the ordinary ontology cards, including the volunteering demo. Samples remain available through search, the public ontology API and MCP `list_ontologies` (`isSample: true`, with attribution in `sample`). Source and licence notices appear on the overview, public draft and release pages, and repository README.

## Sources and licences

The provenance source of truth is [upstream/SOURCES.md](../packages/core/fixtures/samples/upstream/SOURCES.md). These checked-in upstream files are unmodified. The conversion registry is [samples.ts](../packages/shared/src/samples.ts).

| Sample | Authoritative vocabulary / original namespace | Publisher and upstream copy | Licence | SolidOS use |
| --- | --- | --- | --- | --- |
| Solid Terms | [Solid Terms](http://www.w3.org/ns/solid/terms), `http://www.w3.org/ns/solid/terms#` | Solid Project; solid/vocab `b2ec12c3`, `solid-terms.ttl` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Account settings, profile discovery and type indexes |
| Web Access Control | [Web Access Control](http://www.w3.org/ns/auth/acl), `http://www.w3.org/ns/auth/acl#` | W3C; w3c/ns `ce359b43`, `auth/acl.ttl` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) | Sharing and permissions |
| Linked Data Platform | [LDP](http://www.w3.org/ns/ldp), `http://www.w3.org/ns/ldp#` | W3C; w3c/ns `ce359b43`, `ldp.ttl` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) | Pod folders and resource browsing |
| Workspace | [Workspace Ontology](http://www.w3.org/ns/pim/space), `http://www.w3.org/ns/pim/space#` | W3C; w3c/ns `ce359b43`, `pim/space.ttl` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) | Storage, workspaces and preferences |
| Meeting | [Meeting Ontology](http://www.w3.org/ns/pim/meeting), `http://www.w3.org/ns/pim/meeting#` | W3C; w3c/ns `ce359b43`, `pim/meeting.ttl` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) | Meeting pane |
| Forms and user interface | [User Interface Ontology](http://www.w3.org/ns/ui), `http://www.w3.org/ns/ui#` | W3C / Tim Berners-Lee; w3c/ns `ce359b43`, `ui.ttl` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Form rendering and form editor in solid-ui |
| Workflow and issue tracking | [Issue Tracking Ontology](http://www.w3.org/2005/01/wf/flow), `http://www.w3.org/2005/01/wf/flow#` | W3C / Tim Berners-Lee; SolidOS issue-pane `204e40ff`, `src/ontology/wf.ttl` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) for the published vocabulary; issue-pane repository is MIT | Issue pane and meeting action items |
| vCard | [vCard Ontology](http://www.w3.org/2006/vcard/ns), `http://www.w3.org/2006/vcard/ns#` | W3C Interest Group Note; @zazuko/rdf-vocabularies 2023.1.19, `ontologies/vcard.nq` | [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/) | Address book and contacts |
| FOAF | [FOAF Vocabulary Specification](http://xmlns.com/foaf/0.1/), `http://xmlns.com/foaf/0.1/` | FOAF Project / Dan Brickley and Libby Miller; @zazuko/rdf-vocabularies 2023.1.19, `ontologies/foaf.nq` | [CC BY 1.0](https://creativecommons.org/licenses/by/1.0/) | Profiles, people and social links |

All nine are exposed by SolidOS's solid-namespace prefixes. See the upstream provenance document for repository and package links. Names identify the original vocabularies and their software ecosystem; they do not imply endorsement of Concord.

## Reproduce the conversion

Run `pnpm samples:convert` from the checkout. It uses the installed TypeScript tooling and reads only local files. It rewrites the nine `.ttl` files under `packages/core/fixtures/samples/`, never `upstream/`. No timestamps, random identifiers or network responses enter the output. Each file starts with a provenance comment and repeats the source, derivation, original licence, publisher and changes on its `owl:Ontology` header.

The converter preserves named vocabulary IRIs and original namespaces, labels and comments. RDFS classes and properties become explicit OWL declarations. Referenced external classes and properties are declared locally instead of fetching imports. Where RDFS metamodel constraints use reserved RDF/RDFS classes, the constraints are omitted. Properties that mix schema metadata and data, or cannot be assigned one unambiguous logical kind, become annotation properties. This deliberately gives those statements less logical force in Concord's copy.

Unsupported datatype ranges widen to `rdfs:Literal`; annotation values such as `xsd:date` dates retain their lexical value as strings. These choices let the **raw output**, without Concord's runtime datatype rewrite, pass sparq's OWL 2 DL profile check, consistency and complete classification, with no unsatisfiable classes. These are conversions for exploration; consult the original when implementing Solid software.

| Vocabulary | Particular conversion decisions and reasons |
| --- | --- |
| Solid Terms | Resolve `rdf:Property` declarations from ranges and use. Declare referenced profile and type-index terms. Name anonymous provenance records with stable URNs. Remove reserved `rdfs:Resource` constraints, and represent Dublin Core provenance as annotations. |
| Web Access Control | Promote RDFS classes and properties; declare external agents and groups. Treat `acl:accessControl` and its `rdfs:seeAlso` parent as annotations to avoid assigning the built-in annotation predicate an object-property kind. Class-valued metadata loses its metamodel ranges. |
| LDP | Retain container subclass relations and resource links. Name anonymous publisher/author records with stable URNs so the strict checker has no unchecked anonymous-individual restrictions. Normalise legacy `owl:Individual` to `owl:NamedIndividual`; omit reserved resource/list/property ranges. |
| Workspace | Add missing class declarations inferred from superclass statements; retain the storage disjoint union. Workspace hints remain annotations when they refer to classes. |
| Meeting | Keep the original `meeting:label` statement and add `rdfs:label` for Meeting. Supply labels from local names where absent. Only ranges or actual resource use justify object properties; otherwise unconstrained properties remain annotations. |
| Forms and user interface | Declare classes inferred from the field hierarchy. Keep metamodel hints and IRI-valued booleans as annotations. Omit embedded form collections and their otherwise unreachable anonymous fragments, because the OWL RDF mapping cannot consume them as axioms; complete forms remain in `upstream/ui.ttl`. Replace the invalid named CSS-colour facet structure with a string datatype; keep the colour term and description. Class disjoint unions remain. |
| Workflow | Expand legacy N3 bare names using the original default namespace, leaving strings and comments alone. Omit label-only anonymous inverse properties: they do not identify a valid inverse property expression. Declare referenced states, documents and work classes. Retain Task/ActionItem disjoint unions. |
| vCard | Flatten named graphs. Keep class unions, intersections and qualified/cardinality restrictions. Widen unsupported date members inside data-range unions to `rdfs:Literal`. |
| FOAF | Flatten named graphs and resolve conflicting property kinds as annotations, propagating that kind through incompatible property hierarchies. Omit object-only inverse-functional characteristics from datatype properties. Keep named class hierarchies, disjointness and compatible logical property axioms. |

OWL validity is distinct from Concord's editorial house style. Original repeated labels, missing definitions and names such as `vcard:street-address` can still appear in quality findings. Changing term IRIs to satisfy Concord's CamelCase convention would break the requirement to preserve the vocabulary. These original editorial findings are retained, and the existing change-review validation rules still apply.

## Seeding and maintenance

The demo-mode `sample-seed` start-up task uses a renewable shared lease, rechecks slugs while holding it, and uses the volunteering demo's release helper. Both ontology stores follow that same path. A project with an existing slug is always left untouched, whether it is a sample, an edited project or a partially completed seed; it is never removed or reseeded. This prioritises preserving edits if a function stops during publication. An administrator can use reset-demo to rebuild the demo dataset, including all nine samples.

Samples wait while an interrupted initial volunteering seed is being repaired, so they do not prevent its existing recovery path. Reset and demo sign-in/persona entry points also seed missing samples. With demo mode off, no sample task is registered and the seeder creates nothing.
