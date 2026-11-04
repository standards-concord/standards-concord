import { beforeAll, describe, expect, it } from 'vitest';
import { canCastVote, type ApprovalRule, type ChangeRequest, type GovernancePolicy, type OntologyProject, type Release, type Role } from '@concord/shared';
import { clock } from '../src/clock.js';
import { HttpError, openDb, put } from '../src/db.js';
import { addVote, getCR, governanceFor } from '../src/services/changeRequests.js';
import { canVote, template } from '../src/services/governance.js';
import { setRoles } from '../src/services/ontologies.js';
import { releaseGovernance, voteOnRelease } from '../src/services/releases.js';
import { createUser } from '../src/services/users.js';

const ROLES: Role[] = ['owner', 'steward', 'editor', 'reviewer', 'member', 'contributor', 'agent', 'odi'];
const subsets = <T>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
/** Every non-empty membership a person can hold. */
const MEMBERSHIPS = subsets(ROLES).filter((r) => r.length);
/** Each role alone, no role, every role, and the custom policies that list agents as voters. */
const VOTER_ROLES: Role[][] = [[], ...ROLES.map((r) => [r]), ['member', 'agent'], ['agent', 'odi'], ROLES];

const voting = (voterRoles: Role[]): ApprovalRule => ({
  approverRoles: ['steward'],
  minApprovals: 1,
  reviewPeriodDays: 0,
  lazyConsensus: false,
  vetoRoles: [],
  autoMerge: false,
  vote: { voterRoles, quorum: 1, threshold: 1, durationDays: 30 },
});

/** An ontology whose members hold every possible membership, with a change and a release open for a vote. */
async function stage(voterRoles: Role[]) {
  const base = template('working-group') as GovernancePolicy;
  const governance: GovernancePolicy = { ...base, odiPrivilege: 'none', changes: { ...base.changes, major: voting(voterRoles) }, releases: { ...base.releases, major: voting(voterRoles) } };
  const id = `ont-votes-${voterRoles.join('-') || 'none'}`;
  const now = clock.iso();
  put('ontologies', { id, slug: id, title: id, governance, ownerIds: [], createdAt: now, updatedAt: now } as unknown as OntologyProject);
  const author = await createUser({ name: 'Author', provider: 'demo', subject: `${id}-author` });
  setRoles(id, author.id, ['steward']);
  // An eligible member who never votes, so neither vote closes early because everyone has voted.
  const silent = await createUser({ name: 'Silent', provider: 'demo', subject: `${id}-silent` });
  setRoles(id, silent.id, ROLES);
  const voters = [];
  for (const roles of MEMBERSHIPS) {
    const u = await createUser({ name: roles.join('+'), provider: 'demo', subject: `${id}-${roles.join('+')}` });
    setRoles(id, u.id, roles);
    voters.push({ u, roles });
  }
  const cr = put(
    'changeRequests',
    { id: `${id}-cr`, number: 1, ontologyId: id, title: 'A major change', description: '', kind: 'change', origin: 'manual', authorId: author.id, ops: [], status: 'voting', classification: { level: 'major' }, validation: { passed: true }, timeline: [], createdAt: now, updatedAt: now, statusSince: now, reviewStartedAt: now } as unknown as ChangeRequest,
    id,
  );
  const release = put('releases', { id: `${id}-rel`, ontologyId: id, version: '2.0.0', level: 'major', status: 'voting', changeRequestIds: [], notes: '', versionIRI: '', createdBy: author.id, createdAt: now, statusSince: now } as Release, id);
  return { voters, cr, release };
}

const accepts = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) return false;
    throw err;
  }
};

beforeAll(() => {
  openDb();
});

describe('vote eligibility', () => {
  it('never accepts a vote from someone who only acts as an agent, even when agents are listed as voters', () => {
    expect(canCastVote(['agent'], ['member', 'agent'])).toBe(false);
    expect(canCastVote(['agent', 'member'], ['member', 'agent'])).toBe(true);
    expect(canCastVote([], ['member'])).toBe(false);
  });

  it('accepts a change or release vote exactly when the tally counts it, for every membership', { timeout: 300_000 }, async () => {
    const mismatches: string[] = [];
    for (const voterRoles of VOTER_ROLES) {
      const { voters, cr, release } = await stage(voterRoles);
      for (const { u, roles } of voters) {
        const who = `${roles.join('+')} under [${voterRoles.join(', ')}]`;
        // A change request vote: accepted by addVote, counted by the evaluator.
        const crBefore = governanceFor(getCR(cr.id)).vote!.cast;
        const crAccepted = await accepts(() => addVote(getCR(cr.id), u, 'yes'));
        const crCounted = governanceFor(getCR(cr.id)).vote!.cast === crBefore + 1;
        if (crAccepted !== crCounted) mismatches.push(`change: ${who} accepted=${crAccepted} counted=${crCounted}`);
        // A release vote: accepted by voteOnRelease, counted by the evaluator.
        const relBefore = releaseGovernance(release).vote!.cast;
        const relAccepted = await accepts(() => voteOnRelease(release, u, 'yes'));
        const relCounted = releaseGovernance(release).vote!.cast === relBefore + 1;
        if (relAccepted !== relCounted) mismatches.push(`release: ${who} accepted=${relAccepted} counted=${relCounted}`);
        // The simulation and the app ask exactly the people whose votes are accepted.
        if (canVote(voting(voterRoles), roles) !== crAccepted) mismatches.push(`ask: ${who}`);
      }
      // Both stayed open for the whole run, so every vote above was a real attempt.
      expect(getCR(cr.id).status, `change under [${voterRoles.join(', ')}]`).toBe('voting');
      expect(release.status, `release under [${voterRoles.join(', ')}]`).toBe('voting');
    }
    expect(mismatches).toEqual([]);
  });
});
