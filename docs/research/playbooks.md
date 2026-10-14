# ODI open standards playbook drafts: what can be reused

**Sources (Google Drive, ODI drafts; the owner says they are outdated):**
- **[RUN]** "Running_Data_Standards_Projects_Third_Draft" (1WPQzfwBjnEUtIXvLVRaYqIXAs3JzLpQ_LMxg04PIxzs). This is the main process playbook: 12 principles plus 5 stages, about 77k characters.
- **[INTRO]** "Introducing open standards for data" (1on5mLS5z_xAVOz6ScURdxi_FZQLiLZD17P2y4dM4lQQ). Definitions, the types of standard, and a short AI section.
- **[IMPACT]** "Open standards for data Impact guide" (1EYS-Kllaw5T1uEDRIUOTIiicuWbTapFDOaDr8UzYvGw). Policy, economic, social and technology impacts, mostly told through case studies.

**Reader:** someone designing an AI-assisted collaborative ontology and standards development platform. The focus is on structures the platform could build in: stages, roles, artefacts, gates and checklists.

---

## 1. Lifecycle model (the main thing to reuse)

[RUN] describes "five stages of an agile data standards project". Each stage has a stated audience, typical activities, **expected outputs** and useful tools. Together they form a ready-made stage-gate model.

| Stage | Typical duration [RUN] | Exit artefacts ("Expected outputs") |
|---|---|---|
| **1. Pre-project: making the case** | "A few weeks to a few months" | Problem statement (including why a *standard* rather than "a tool, dataset, or piece of guidance"); initial stakeholder map; sponsor/mandate; early view of short- and long-term funding |
| **2. Discovery: understand the landscape** | "Three to six months" | Extended stakeholder map; SMART aims; **decision on path: develop, adopt, or both**; scope, features and use cases; **candidate data classes** "grounded in what organisations are already recording"; **record of terminology variation**; outline governance; IP guidelines, licence and funding model; communication channels |
| **3a. Delivery: Develop** | "Almost always a year or more" | Stable machine- and human-readable versions; guides; translations; **test suites** "that both conform to and deliberately break the standard"; convert/validate/view tools; code libraries; early-adopter experiences; development infrastructure |
| **3b. Delivery: Adopt** | "Weeks to a few months" | Documented gap analysis; working implementation; documented local extensions; trained staff and internal owner; lessons learned |
| **4. Stewardship** | "Ongoing, for the life of the standard" | Monitored adopter base and KPIs; governance principles and roles; documentation of each review; a decision at each review (maintain, update, rescope or retire); communications; **version history with provenance**; or a retirement notice and archive |

The model loops. Updating a standard sends work "back into **Delivery: Develop**", and weak adoption can trigger "revisiting Discovery". [IMPACT] gives a parallel lifecycle: idea, then scoping, development, launch and adoption, review, updates, and finally "withdrawn, retired or abandoned".

**Platform implications:** model stages as states, with an exit checklist for each one, and include the Discovery decision node (develop, adopt or extend). Two timing lessons are worth surfacing in the product. "Writing the technical specification is often the easy part": in the GTFS case the first export took "under an hour", while agreement and testing took years. And organisations "often underestimate how long it can take".

## 2. Guiding principles (good seed text for a project charter) [RUN]

The 12 principles are:
1. Be clear on purpose.
2. Know your community "and who's missing from it".
3. Language matters: "Concrete examples do more work than abstract definitions".
4. Understand how the standard will be used, and by whom.
5. Develop use cases, separating core from optional to avoid "over-specification that becomes a barrier to adoption".
6. Map common features and extensions, i.e. where practice "converge[s] and where [it] diverge[s]".
7. Use existing standards.
8. Choose the right development process, on a spectrum from formal to informal.
9. Follow the OpenStand principles. The draft notes that the coalition is "no longer an active initiative".
10. Agree ownership and copyright early, including rights over contributions.
11. Develop visible guidance on governance and the roadmap.
12. Deliver a robust product.

The success criteria from user research [RUN] could double as a review rubric. Successful standards: focus on a specific problem; work well with other standards; "are clear on how and why decisions were made"; have been implemented and tested; are "robust without being verbose"; use an open, adaptable process; "are delivered early rather than perfected in isolation"; and involve diverse people.

## 3. Roles and stakeholders

**Ecosystem stakeholders** [RUN, Pre-project]: data publishers, data modellers, data users (often domain experts), two kinds of developers (tools for publishers and tools for users), standards developers (who work "on behalf of standards owners"), and policy groups. [IMPACT] adds the owner, the sponsor/funder, implementers, third-party support providers, and businesses built on the standard.

**Key stakeholders and early adopters** are the people who "help shape the standard", "act as advocates and ambassadors" and "help test the standard". The draft flags real "anxieties about politics, monopolies, and who ultimately controls a standard". The response it recommends is to be clear early about ownership.

**Discovery team skills** [RUN]: researcher; data engineering, modelling and architecture; domain experts; business analysts ("to capture and reach consensus on sector or industry needs"); community engagement; project and product management.

**Working group roles** [RUN, Develop], given as a table:
- **Chair**: "Leads the group to consensus, and takes responsibility for governance and managing change". Needs to be aware of "how disagreements can be sabotaged or drawn out" and keeps decisions and actions "fully and accurately documented".
- **Authors/editors**: write the spec "in line with the group's decisions". The W3C's "editor" framing applies: the role is about channelling the community's ideas. They keep the record of how decisions, use cases and requirements become the specification.
- **Testers/implementers**: own the test framework. "A single unclear statement in a specification can cause real problems."
- **Reviewers/contributors**: domain experts. They are expected to "avoid reopening settled debates".

Structure: working groups report to a **Steering Group or Board** that sets "strategic vision and policy guardrails". Complex projects can run several working groups, one per use case or theme. The example given is the ODI volunteering programme, which had separate Standards WG and Steering Group bodies.

**Platform implications:** these roles map directly onto permissions. Decision logging and a "settled debate" marker (a link back to the earlier decision) are explicitly motivated by the text. An AI could reasonably take on parts of the editor role: drafting text from recorded decisions and keeping the traceability from requirements to specification.

## 4. Requirements gathering and use cases

Discovery activities [RUN]: review Pre-project feedback; do research; write a theory of change; "develop and prioritise use cases, and develop requirements and user stories"; identify core features; consider interoperability ("reuse open formats, vocabularies and identifiers"), extensibility and translations; plan testing; set SMART aims.

The **bottom-up modelling method** is the most concretely reusable part for ontology work. Under "Understand existing data products and services" it says to:
- gather existing spreadsheets, databases, APIs, reports and dashboards;
- compare them side by side to find shared and divergent fields;
- "group recurring concepts into candidate classes of data";
- "note where organisations use different terms for the same concept";
- identify genuine gaps;
- involve domain experts, because real patterns "usually need[s] domain knowledge, not just a spreadsheet comparison".

The 360Giving case study illustrates the method: the backbone was found "by analysing what already existed rather than designing top-down".

Supporting tools named: the ODI **Open Standards for Data Canvas** (problem, solution, resources, risks, impacts), **data ecosystem mapping**, and **empathy maps**.

**Platform implications:** this is a strong fit for AI assistance. An AI could ingest sample schemas and spreadsheets, cluster fields into candidate classes, build a synonym and term-variation register, and draft use cases and user stories for humans to validate.

## 5. Governance and decision-making

- **Formality spectrum.** Formal options are BSI PAS 0, W3C, IEEE and BOMOS. The informal end is GTFS: "responsiveness over ceremony… open change management through repositories like GitHub". The factors for choosing between them [RUN, Discovery] are: how clear the requirements are, how complex the problem is, team familiarity with the method, how available domain experts are, funder and adopter expectations, and risk, schedule and budget.
- **Governance design questions** [RUN, Stewardship]: what users expect (mandated standards need formality from day one); how many stakeholders there are; how complex the standard is; how mature it is. "Most standards programmes start with lightweight governance that matures." There should be a senior governance team or board, either the owner or an independent body ("independence can itself build trust"). The board "sets policy, makes decisions on which features to prioritise". Reference examples: GTFS guiding principles and the OCDS governance principles.
- **Approval gate** after Discovery. Sign-off covers "scope; aims and objectives; who will develop the standard; early adopters; prioritised features; the development plan itself; and identified risks, schedule and budget."
- **Consensus.** It is invoked everywhere: the chair leads to consensus, reviews must "build consensus in the community for any proposed changes", and decisions are about "building consensus… not just announcing it". **There is no voting mechanism, quorum, objection process or appeals procedure.** That is a gap.
- **Change-control exemplar** (OCDS case study): anyone raises issues via GitHub or the mailing list; a technical team reviews; the community peer-reviews proposed changes; a working group of OCP staff, an advisory board and the technical team approves. GTFS's "living standard" model: changes can be adopted "within weeks, given evidence they're useful, tested and community approved".
- **Policy linkage** [IMPACT]: governments typically tie standards to "secondary legislation or a code of practice, which can be changed more easily". It also warns that "picking the wrong standard, or mandating it too early, can stifle innovation".

## 6. Review, versioning, maintenance and retirement [RUN, Stewardship]

**Review process checklist.** Agree that a review is needed; decide who reviews and who makes the final call; set the process; prioritise feature requests, errors and feedback; carry out the review and publish the results; build consensus; then decide to do nothing, update or retire. The review questions cover: adoption (numbers and whether the *target types* of adopter took it up), ease of adoption, impact, interoperability, errors, requests (filtered "against the standard's original aims"), and available resources. A schedule should be stated explicitly in the governance.

**Updating:**
- Separate major ("breaking") changes from minor ones. Breaking changes include tools no longer working, a changed data structure, or a vocabulary gaining "significant new entries or classifications".
- Use consistent version numbering (1.0, 1.1, 2.0).
- **Track provenance with PROV-O and DCAT** rather than "a bespoke scheme nobody else can read".
- Decide how to bundle changes, and announce them with lead time.

**Retirement.** Retire "actively" rather than "passively": circulate the decision, gift the IP, keep channels read-only with a notice, and archive (for example via the Internet Archive).

**Infrastructure requirements** [RUN, Develop] are in effect a platform requirements list: public sharing of the standard and its test data, automated testing, "tracks changes, giving you an audit trail you can roll back", community contributions, open documentation, and public issue reporting.

## 7. Adoption

- **Adopter-side checklist** [RUN, Adopt]: assess fit (licence, needs, maintenance, guidance), cost against gain, and internal sign-off; do a **field-by-field gap analysis**; flag legacy data early; define "good enough conformance" for the first release; prefer documented extension points or feature requests over "a private fork"; treat deviations as "a temporary bridge"; phase the rollout; train staff; feed back to the owner. The Boulder County/BLDS case study is a model of honest, published gap mapping.
- **Owner-side support** [RUN, Stewardship]: a launch moment, a stable findable version, case studies, training, a helpdesk, forums, and KPIs for direct and indirect adopters plus a refreshed ecosystem map. "A standard that looks unused looks unviable."
- **Standard selection questions** [RUN, Discovery]: Is it openly licensed? Does it meet our needs? Is it actively maintained? Is there enough guidance? Places to search include ISO, GitHub, the UK open standards list, the US Data Federation, and the Data Standards Directory.

## 8. Data modelling and semantic web content

This is better than expected, but still introductory.

- **Types of standard** [INTRO]: share vocabulary (registers, taxonomies, vocabularies, ontologies), exchange data (formats, schemas, APIs, mappings), and provide guidance (units, processes, codes of practice). What a vocabulary can standardise: concepts, words, attributes, relationships, identifiers, units and models.
- **Model choice** [RUN]: vocabulary, taxonomy or ontology; relational or graph.
- **Semantic web** [RUN]: a short explainer of RDF, OWL, SPARQL and SHACL; dereferenceable identifiers; reuse of existing ontologies; the 5-star scheme. The worked example is the ODI **Volunteering and Social Action Ontology**, which reuses OWL-Time and GeoSPARQL, uses dereferenceable URLs, has a WebVOWL view, and is public on GitHub. Tools named: Protégé, WebProtégé, VocBench, WIDOCO, WebVOWL, plus DCAT, Dublin Core, Croissant and OpenAPI for documentation. It sensibly adds that "Not every standard needs this level of technical machinery."

## 9. Where the drafts are outdated or thin

- **AI.** None of the three covers AI-*assisted* standards development. [INTRO] only covers "AI-ready data" (the ODI Framework for AI-ready Data: dataset properties, metadata, infrastructure and governance; "data policy as code"). Croissant is mentioned once. Nothing addresses LLM drafting, AI-mediated consensus, provenance of AI-generated content, or human-in-the-loop review.
- **OWL depth.** This is a primer only. Missing: competency questions, ontology design patterns, modularisation and imports, alignment and mapping (SKOS/OWL equivalence), term-level deprecation, URI persistence and namespace policy, reasoning and consistency checks in CI, and SHACL-based conformance testing workflows.
- **Decision mechanics.** "Consensus" is never operationalised. There is no voting, quorum, lazy consensus, objection handling, escalation or appeals process, and no conflict-of-interest or membership rules.
- **Change control at term level.** Versioning is document-level semver only. There is no guidance on per-term status (proposed, stable, deprecated), change proposals or RFC templates, or diff and review of ontology changes.
- **Templates.** Canvases and tools are referenced by link but not included. There are no charter, ToR, issue or change-request templates.
- **Staleness.** Many case studies are from the 2010s (DfID, UKATG, Socrata, GTFS circa 2005). OpenStand is inactive. The ODI catalogue link is missing (there is an editorial placeholder). Links point to internal Google Docs. [IMPACT] contains stray markdown and formatting artefacts.
- **Not covered:** distributed or asynchronous collaboration tooling beyond GitHub and mailing lists; accessibility is mentioned only in passing; metrics of standard *quality*, as opposed to adoption, are thin.
