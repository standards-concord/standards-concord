import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { Role, User } from '@concord/shared';
import { api, type OntologyDetail } from '../api';
import { useAsync, useLocalStorage } from './hooks';
import { useSession } from './session';
import { useDemoOntology } from './ontologies';

export const STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'role', title: 'Pick your role' },
  { id: 'tour', title: 'Explore the demo' },
  { id: 'simulate', title: 'Simulate the others' },
  { id: 'feedback', title: 'Give feedback' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

interface State {
  step: number;
  open: boolean;
  done: Record<string, boolean>;
  started: boolean;
}

interface Ctx extends State {
  setStep: (n: number) => void;
  next: () => void;
  prev: () => void;
  setOpen: (o: boolean) => void;
  toggleTask: (id: string) => void;
  reset: () => void;
  /** Demo ontology detail (members) for role display; undefined while loading. */
  demo?: OntologyDetail;
  reloadDemo: () => Promise<void>;
  myRoles: Role[];
}

const C = createContext<Ctx | null>(null);
const INITIAL: State = { step: 0, open: false, done: {}, started: false };

export function WalkthroughProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useLocalStorage<State>('concord.walkthrough.v1', INITIAL);
  const { session } = useSession();
  const demoSummary = useDemoOntology();
  const demoState = useAsync(async () => (demoSummary ? api.ontology(demoSummary.id) : undefined), [demoSummary?.id, session?.user?.id]);

  const myRoles = useMemo<Role[]>(() => {
    const uid = session?.user?.id;
    if (!uid || !demoState.data) return [];
    return demoState.data.members?.find((m) => m.userId === uid)?.roles ?? [];
  }, [demoState.data, session?.user?.id]);

  const setStep = useCallback((n: number) => setState((s) => ({ ...s, step: Math.max(0, Math.min(STEPS.length - 1, n)), started: true })), [setState]);
  const value: Ctx = {
    ...state,
    setStep,
    next: () => setStep(state.step + 1),
    prev: () => setStep(state.step - 1),
    setOpen: (open) => setState((s) => ({ ...s, open, started: s.started || open })),
    toggleTask: (id) => setState((s) => ({ ...s, done: { ...s.done, [id]: !s.done[id] } })),
    reset: () => setState({ ...INITIAL, started: true }),
    demo: demoState.data,
    reloadDemo: demoState.reload,
    myRoles,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useWalkthrough() {
  const c = useContext(C);
  if (!c) throw new Error('useWalkthrough outside provider');
  return c;
}

/* ------------------------------------------------------------------ roles */

/** The five tester-facing roles the walkthrough offers. */
export const TESTER_ROLES: { key: string; title: string; roles: Role[]; blurb: string }[] = [
  { key: 'steward', title: 'Ontology steward', roles: ['steward', 'owner', 'editor'], blurb: 'Run the process: triage requests, merge approved changes, cut releases, tune governance.' },
  { key: 'contributor', title: 'Domain expert / contributor', roles: ['contributor', 'reviewer'], blurb: 'Describe how you use the data, answer the interviewer, report problems.' },
  { key: 'member', title: 'Voting member', roles: ['member'], blurb: 'Review proposed changes and vote on the ones the policy puts to a vote.' },
  { key: 'odi', title: 'ODI oversight', roles: ['odi'], blurb: 'Keep an eye on quality and process; your powers depend on the governance policy.' },
  { key: 'agent', title: 'Agent developer', roles: ['agent', 'contributor'], blurb: 'Connect Claude Code or Codex over MCP and have your agent report gaps.' },
];

/** Best-effort mapping of a persona to one of the tester roles. */
export function testerRoleFor(user: User, memberRoles?: Role[]): (typeof TESTER_ROLES)[number] {
  const rs = memberRoles ?? [];
  if (rs.includes('odi')) return TESTER_ROLES[3];
  if (rs.includes('agent')) return TESTER_ROLES[4];
  if (rs.includes('steward') || rs.includes('owner')) return TESTER_ROLES[0];
  if (rs.includes('member')) return TESTER_ROLES[2];
  if (rs.length) return TESTER_ROLES[1];
  const p = `${user.persona ?? ''} ${user.organisation ?? ''}`.toLowerCase();
  if (/\bodi\b|oversight|open data institute/.test(p)) return TESTER_ROLES[3];
  if (/agent|developer|engineer|codex|claude code/.test(p)) return TESTER_ROLES[4];
  if (/steward|chair|owner|lead/.test(p)) return TESTER_ROLES[0];
  if (/vot|member|board/.test(p)) return TESTER_ROLES[2];
  return TESTER_ROLES[1];
}

export interface TourTask {
  id: string;
  label: string;
  detail: string;
  to: string;
}

export function tasksFor(roles: Role[], ontologyId?: string): TourTask[] {
  if (!ontologyId) return [];
  const o = `/o/${ontologyId}`;
  const all: Record<string, TourTask> = {
    browse: { id: 'browse', label: 'Browse the ontology', detail: 'Look at the class tree, a term’s definition and the graph view.', to: `${o}/browse` },
    interview: { id: 'interview', label: 'Describe a use case to the interviewer', detail: 'Chat (or talk) about how you use this data; watch the use case document fill in.', to: `${o}/use-cases?start=1` },
    meeting: { id: 'meeting', label: 'Upload or simulate a meeting', detail: 'Run a simulated live call and see the co-lead bot raise follow-up questions.', to: `${o}/meetings` },
    review: { id: 'review', label: 'Open a change request and review it', detail: 'Read the AI analysis and validation, then approve, request changes or object.', to: `${o}/changes` },
    vote: { id: 'vote', label: 'Vote on a change', detail: 'Find a request in “Voting” and cast your vote; watch quorum and threshold.', to: `${o}/changes?status=voting` },
    synthesise: { id: 'synthesise', label: 'Draft changes from use cases', detail: 'Press Draft changes, pick the ready use cases and let the platform draft ontology changes.', to: `${o}/use-cases` },
    merge: { id: 'merge', label: 'Merge an approved change and draft a release', detail: 'Approved changes go into the working draft; releases get a semver number.', to: `${o}/releases` },
    governance: { id: 'governance', label: 'Change the governance policy', detail: 'Pick a template or tune approvals, votes, lazy consensus and ODI privilege.', to: `${o}/governance` },
    agent: { id: 'agent', label: 'Connect a coding agent', detail: 'Create a token and add the MCP connector to Claude Code or Codex.', to: `${o}/agents` },
    linkml: { id: 'linkml', label: 'View the ontology in LinkML', detail: 'Switch formats — LinkML, SHACL, Turtle and more.', to: `${o}/source?format=linkml` },
    bug: { id: 'bug', label: 'Report a problem with a term', detail: 'From any term page, report a bug; it becomes a change request.', to: `${o}/browse` },
  };
  const pick = (...ids: string[]) => ids.map((id) => all[id]);
  if (roles.includes('odi')) return pick('browse', 'review', 'governance', 'linkml', 'vote');
  if (roles.includes('agent')) return pick('agent', 'browse', 'linkml', 'review');
  if (roles.includes('steward') || roles.includes('owner')) return pick('meeting', 'synthesise', 'review', 'merge', 'governance', 'linkml');
  if (roles.includes('member')) return pick('browse', 'review', 'vote', 'interview');
  return pick('interview', 'browse', 'bug', 'meeting', 'review', 'linkml');
}
