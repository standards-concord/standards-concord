/** Attribution for a converted vocabulary supplied for trying Concord. */
export interface SampleAttribution {
  source: string;
  sourceTitle: string;
  publisher: string;
  licence: { name: string; url: string };
  upstreamCopy: string;
  changes: string;
  usedBy: string;
}

export interface SampleVocabulary extends SampleAttribution {
  slug: string;
  title: string;
  prefix: string;
  namespace: string;
  description: string;
}

export const SAMPLE_HEALTH_NOTE = "Concord's checks flag some wording inherited from the original; it is kept as published so the copy stays faithful.";

const w3c = { name: 'W3C Software and Document License', url: 'https://www.w3.org/copyright/software-license-2023/' };
const cc0 = { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
const common = 'Added an ontology header, explicit OWL declarations and declarations for referenced terms. Kept term IRIs, namespaces, labels and comments. Unconstrained or mixed-use properties are annotations; class and property metadata has no metamodel domain or range. Removed reserved RDF/RDFS metamodel constraints. Unsupported datatype ranges are widened to rdfs:Literal; annotation dates keep their lexical values as strings.';

/** One registry for conversion, seeding and attribution. Provenance: fixtures/samples/upstream/SOURCES.md. */
export const SAMPLE_VOCABULARIES: readonly SampleVocabulary[] = [
  {
    slug: 'solid-terms', title: 'Solid Terms', prefix: 'solid', namespace: 'http://www.w3.org/ns/solid/terms#',
    description: 'Settings and links that help Solid apps find profiles, preferences and storage.',
    usedBy: 'SolidOS account settings, profile discovery and type indexes', publisher: 'Solid Project',
    source: 'http://www.w3.org/ns/solid/terms', sourceTitle: 'Solid Terms', licence: cc0,
    upstreamCopy: 'solid-terms.ttl', changes: `${common} Resolved rdf:Property declarations from their ranges and usage. Named anonymous provenance records with stable URNs.`,
  },
  {
    slug: 'acl', title: 'Web Access Control', prefix: 'acl', namespace: 'http://www.w3.org/ns/auth/acl#',
    description: 'Rules describing who can read, write or share a resource in a Solid pod.',
    usedBy: 'SolidOS sharing and permissions', publisher: 'W3C',
    source: 'http://www.w3.org/ns/auth/acl', sourceTitle: 'Web Access Control', licence: w3c,
    upstreamCopy: 'acl.ttl', changes: `${common} Promoted RDFS classes and properties to OWL declarations.`,
  },
  {
    slug: 'ldp', title: 'Linked Data Platform', prefix: 'ldp', namespace: 'http://www.w3.org/ns/ldp#',
    description: 'Resources and containers used to organise linked data on the web.',
    usedBy: 'SolidOS pod folders and resource browsing', publisher: 'W3C',
    source: 'http://www.w3.org/ns/ldp', sourceTitle: 'Linked Data Platform vocabulary', licence: w3c,
    upstreamCopy: 'ldp.ttl', changes: `${common} Preserved container hierarchies and resource links. Named anonymous publisher and author records with stable URNs; normalised owl:Individual declarations.`,
  },
  {
    slug: 'pim-space', title: 'Workspace', prefix: 'space', namespace: 'http://www.w3.org/ns/pim/space#',
    description: 'Personal, shared and public places for keeping data and preferences.',
    usedBy: 'SolidOS workspaces, storage and preferences', publisher: 'W3C',
    source: 'http://www.w3.org/ns/pim/space', sourceTitle: 'Workspace Ontology', licence: w3c,
    upstreamCopy: 'space.ttl', changes: `${common} Declared classes previously described only through their superclass.`,
  },
  {
    slug: 'meeting', title: 'Meeting', prefix: 'meeting', namespace: 'http://www.w3.org/ns/pim/meeting#',
    description: 'Agendas, notes, participants and calls for people meeting online.',
    usedBy: 'SolidOS meeting pane', publisher: 'W3C',
    source: 'http://www.w3.org/ns/pim/meeting', sourceTitle: 'Meeting Ontology', licence: w3c,
    upstreamCopy: 'meeting.ttl', changes: `${common} Retained meeting:label and also supplied an rdfs:label for Meeting.`,
  },
  {
    slug: 'solid-ui-forms', title: 'Forms and user interface', prefix: 'ui', namespace: 'http://www.w3.org/ns/ui#',
    description: 'Fields, forms and display hints used to build interfaces for linked data.',
    usedBy: 'SolidOS form rendering and form editor in solid-ui', publisher: 'W3C / Tim Berners-Lee',
    source: 'http://www.w3.org/ns/ui', sourceTitle: 'User Interface Ontology', licence: cc0,
    upstreamCopy: 'ui.ttl', changes: `${common} Kept form descriptions as annotations where they mix schema and data. Omitted embedded form collections that OWL cannot parse as axioms (the complete forms remain in the upstream copy). Replaced the named CSS colour facet restriction with a string datatype.`,
  },
  {
    slug: 'workflow', title: 'Workflow and issue tracking', prefix: 'wf', namespace: 'http://www.w3.org/2005/01/wf/flow#',
    description: 'Tasks, issues, assignments and the states a piece of work moves through.',
    usedBy: 'SolidOS issue pane and meeting action items', publisher: 'W3C / Tim Berners-Lee; upstream copy maintained by SolidOS',
    source: 'http://www.w3.org/2005/01/wf/flow', sourceTitle: 'Issue Tracking Ontology', licence: w3c,
    upstreamCopy: 'wf.ttl', changes: `${common} Expanded legacy N3 bare names in the original namespace. Removed label-only anonymous inverse properties, which do not identify an OWL inverse.`,
  },
  {
    slug: 'vcard', title: 'vCard', prefix: 'vcard', namespace: 'http://www.w3.org/2006/vcard/ns#',
    description: 'Names, addresses and contact details for people and organisations.',
    usedBy: 'SolidOS address book and contacts', publisher: 'W3C',
    source: 'http://www.w3.org/2006/vcard/ns', sourceTitle: 'vCard Ontology', licence: w3c,
    upstreamCopy: 'vcard.nq', changes: `${common} Flattened the N-Quads document into one ontology graph and retained OWL class restrictions. Widened non-OWL date members in datatype unions to rdfs:Literal.`,
  },
  {
    slug: 'foaf', title: 'FOAF', prefix: 'foaf', namespace: 'http://xmlns.com/foaf/0.1/',
    description: 'People, organisations, their profiles and the connections between them.',
    usedBy: 'SolidOS profiles, people and social links', publisher: 'FOAF Project / Dan Brickley and Libby Miller',
    source: 'http://xmlns.com/foaf/0.1/', sourceTitle: 'FOAF Vocabulary Specification',
    licence: { name: 'CC BY 1.0', url: 'https://creativecommons.org/licenses/by/1.0/' },
    upstreamCopy: 'foaf.nq', changes: `${common} Flattened N-Quads and resolved properties declared with both object and datatype kinds as annotations. Removed inverse-functional characteristics on literal-valued properties and incompatible characteristics and property axioms on those annotations.`,
  },
];
