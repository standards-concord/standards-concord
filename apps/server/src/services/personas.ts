import type { Role } from '@concord/shared';

/**
 * Simulated participants for the alpha walkthrough. Testers pick one of the
 * "playable" roles and the others act around them. All organisations are fictional.
 */
export interface PersonaSpec {
  key: string;
  name: string;
  organisation: string;
  persona: string;
  roles: Role[];
  /** Shown on the walkthrough's pick-a-role screen. */
  playable?: { title: string; blurb: string };
}

export const PERSONAS: PersonaSpec[] = [
  {
    key: 'priya',
    name: 'Priya Shah',
    organisation: 'Open Data Institute',
    persona: 'Data standards lead at the ODI. Chairs the volunteering data standard working group. Pragmatic, cares about adoption and about not breaking existing implementers.',
    roles: ['owner', 'steward', 'editor', 'member', 'odi'],
    playable: { title: 'Steward', blurb: 'Run the working group: triage proposals, set governance, cut releases.' },
  },
  {
    key: 'tom',
    name: 'Tom Okafor',
    organisation: 'Volunteer Connect (platform)',
    persona: 'Ontologist and lead developer at a national volunteering platform. Precise about modelling; pushes for genus–differentia definitions, reuse of schema.org, and avoiding breaking changes.',
    roles: ['editor', 'reviewer', 'member'],
    playable: { title: 'Editor', blurb: 'Turn requirements into ontology changes and review others’ proposals.' },
  },
  {
    key: 'aisha',
    name: 'Aisha Rahman',
    organisation: 'Northvale Council',
    persona: 'Volunteer coordinator at a local council. Not technical; thinks in terms of shifts, rotas, DBS checks and expenses. Wants the standard to match how coordinators actually work.',
    roles: ['member', 'contributor'],
    playable: { title: 'Contributor', blurb: 'Describe how you would use the standard; the AI interviewer turns it into requirements.' },
  },
  {
    key: 'gareth',
    name: 'Gareth Lewis',
    organisation: 'CharityBase CRM',
    persona: 'Developer at a charity CRM vendor that already exports volunteering data. Worried about migration cost; uses coding agents to build integrations.',
    roles: ['member', 'reviewer'],
    playable: { title: 'Implementer', blurb: 'Build against the ontology with a coding agent and report what does not fit.' },
  },
  {
    key: 'mei',
    name: 'Mei Chen',
    organisation: 'Volunteering Futures (charity)',
    persona: 'Data and research officer at a national volunteering charity. Cares about measuring impact: hours volunteered, demographics, outcomes. Careful about personal data.',
    roles: ['member', 'reviewer'],
    playable: { title: 'Voting member', blurb: 'Weigh in on proposals and vote on releases that change the standard.' },
  },
  {
    key: 'daniel',
    name: 'Daniel Brooks',
    organisation: 'Open Data Institute',
    persona: 'ODI technical oversight. Checks that standards meet the ODI’s quality bar (FAIR, licensing, logical consistency). Rarely intervenes.',
    roles: ['odi', 'reviewer'],
  },
];

export const personaByKey = (key: string) => PERSONAS.find((p) => p.key === key);
