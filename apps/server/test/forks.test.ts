import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';

/**
 * Development forks: a developer forks the volunteering ontology, adds the
 * term their app needs, imports the fork's URL, proposes the change upstream,
 * and is told to switch back once it is merged and released.
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;
const VOL = 'https://w3id.org/odi/volunteering#';

async function login(role: string, name: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  return agent;
}

const activityTerms = [
  {
    action: 'add',
    kind: 'class',
    localName: 'VolunteeringActivity',
    label: 'volunteering activity',
    definition: 'A record of time that a volunteer actually gave to a volunteering opportunity on a particular day.',
  },
  {
    action: 'add',
    kind: 'datatypeProperty',
    localName: 'hoursVolunteered',
    label: 'hours volunteered',
    definition: 'The number of hours a volunteer gave in a volunteering activity.',
    domain: ['VolunteeringActivity'],
    range: ['xsd:decimal'],
  },
  {
    action: 'add',
    kind: 'objectProperty',
    localName: 'activityBy',
    label: 'activity by',
    definition: 'The volunteer who gave their time in a volunteering activity.',
    domain: ['VolunteeringActivity'],
    range: ['vol:Volunteer'],
  },
];

/** Fork details need a signed-in user, like the rest of the API's private reads. */
let reader: Agent;

beforeAll(async () => {
  await openDb();
  await seedDemo();
  reader = await login('reviewer', 'Reader Rhi');
});

describe('development forks', () => {
  let dev: Agent;

  it('fork details need sign-in; the fork documents themselves are public', async () => {
    expect((await request(app).get('/api/ontologies/volunteering/forks')).status).toBe(401);
    expect((await request(app).get('/def/volunteering/forks/charitybase-recurring-shifts.ttl')).status).toBe(200);
  });

  it('the demo has a fork from a simulated developer', async () => {
    const res = await reader.get('/api/ontologies/volunteering/forks');
    const seeded = res.body.find((f: { slug: string }) => f.slug === 'charitybase-recurring-shifts');
    expect(seeded.version).toBe('1.0.0-fork.charitybase-recurring-shifts.1');
    expect(seeded.owner.name).toBe('Gareth Lewis');
    expect(seeded.terms).toEqual([expect.objectContaining({ curie: 'vol:recurrenceRule', change: 'added', upstream: 'not-proposed' })]);
  });

  let forkPath: string;

  it('creates a fork that resolves at its own URL, stamped as a pre-release', async () => {
    dev = await login('contributor', 'Dev Dana');
    const res = await dev.post('/api/ontologies/volunteering/forks').send({ name: 'Volunteer hours', purpose: 'Logging volunteer hours in the Helping Hands app' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('volunteer-hours');
    expect(res.body.status).toBe('active');
    expect(res.body.version).toBe('1.0.0-fork.volunteer-hours.0');
    expect(res.body.urls.iri).toMatch(/\/def\/volunteering\/forks\/volunteer-hours$/);
    expect(res.body.urls.formats.turtle).toMatch(/volunteer-hours\.ttl$/);
    expect(res.body.history.length).toBe(1);
    forkPath = '/api/ontologies/volunteering/forks/volunteer-hours';

    const ttl = await request(app).get('/def/volunteering/forks/volunteer-hours').set('Accept', 'text/turtle');
    expect(ttl.status).toBe(200);
    expect(ttl.headers['content-type']).toMatch(/text\/turtle/);
    expect(ttl.headers['access-control-allow-origin']).toBe('*');
    expect(ttl.text).toMatch(/owl:versionInfo "1\.0\.0-fork\.volunteer-hours\.0"/);
    expect(ttl.text).toMatch(/owl:versionIRI <[^>]*\/def\/volunteering\/forks\/volunteer-hours>/);
    expect(ttl.text).toMatch(/owl:priorVersion <https:\/\/w3id\.org\/odi\/volunteering\/1\.0\.0>/);

    const jsonld = await request(app).get('/def/volunteering/forks/volunteer-hours.jsonld');
    expect(jsonld.status).toBe(200);
    expect(jsonld.headers['content-type']).toMatch(/application\/ld\+json/);
    // An import target: Turtle unless the client asks for HTML, with CORS, so fetch() works cross-origin.
    for (const accept of ['*/*', '']) {
      const any = await request(app).get('/def/volunteering/forks/volunteer-hours').set('Accept', accept);
      expect(any.status, accept).toBe(200);
      expect(any.headers['content-type']).toMatch(/text\/turtle/);
      expect(any.headers['access-control-allow-origin']).toBe('*');
    }
    expect((await request(app).get('/def/volunteering/1.0.0.ttl')).headers['access-control-allow-origin']).toBe('*');
    const html = await request(app).get('/def/volunteering/forks/volunteer-hours').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(html.status).toBe(303);
    expect(html.headers.location).toMatch(/\/o\/volunteering\/forks\/volunteer-hours$/);
    expect((await request(app).get('/def/volunteering/forks/nope')).status).toBe(404);
  });

  it('adds terms to the fork without touching the main ontology', async () => {
    const res = await dev.post(`${forkPath}/edits`).send({ terms: activityTerms, message: 'Add volunteering activities' });
    expect(res.status).toBe(200);
    expect(res.body.validation.consistent).toBe(true);
    expect(res.body.terms.map((t: { curie: string }) => t.curie).sort()).toEqual(['vol:VolunteeringActivity', 'vol:activityBy', 'vol:hoursVolunteered']);
    expect(res.body.fork.revision).toBe(1);
    expect(res.body.fork.terms.every((t: { upstream: string }) => t.upstream === 'not-proposed')).toBe(true);

    const ttl = await request(app).get('/def/volunteering/forks/volunteer-hours.ttl');
    expect(ttl.text).toMatch(/vol:VolunteeringActivity/);
    expect(ttl.text).toMatch(/1\.0\.0-fork\.volunteer-hours\.1/);
    // Same term IRIs as upstream will use, so app data stays valid after the merge.
    const view = await reader.get('/api/ontologies/volunteering/view?ref=forks/volunteer-hours');
    expect(view.body.classes.some((c: { iri: string }) => c.iri === `${VOL}VolunteeringActivity`)).toBe(true);
    const main = await reader.get('/api/ontologies/volunteering/view');
    expect(main.body.classes.some((c: { iri: string }) => c.iri === `${VOL}VolunteeringActivity`)).toBe(false);

    // Every format a release offers, generated classes and SHACLC included.
    const js = await request(app).get('/def/volunteering/forks/volunteer-hours.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['access-control-allow-origin']).toBe('*');
    expect(js.text).toMatch(/class /);
    expect((await request(app).get('/def/volunteering/forks/volunteer-hours.shaclc')).status).toBe(200);
    const tgz = await request(app).get('/def/volunteering/forks/volunteer-hours.tgz');
    expect(tgz.status).toBe(200);
    expect(tgz.headers['content-type']).toMatch(/gzip/);

    const detail = await reader.get(forkPath);
    expect(detail.body.history.length).toBe(2);
    expect(detail.body.history[0].subject).toBe('Add volunteering activities');
  });

  it('only lets the owner edit, and refuses edits that make the ontology inconsistent', async () => {
    const other = await login('contributor', 'Other Olu');
    const denied = await other.post(`${forkPath}/edits`).send({ terms: activityTerms });
    expect(denied.status).toBe(403);
    const bad = await dev.post(`${forkPath}/edits`).send({ ops: [{ op: 'setSuperClasses', iri: `${VOL}Skill`, superClasses: [`${VOL}Cause`] }] });
    expect(bad.status).toBe(422);
    const unchanged = await reader.get(forkPath);
    expect(unchanged.body.revision).toBe(1);
  });

  it('tells the developer to keep using the fork and propose it', async () => {
    const check = await dev.get(`${forkPath}/check`);
    expect(check.body.outcome).toBe('keep-using-fork');
    expect(check.body.steps.join(' ')).toMatch(/propose/i);
  });

  let crId: string;
  it('proposes the fork upstream as one change request', async () => {
    const res = await dev.post(`${forkPath}/propose`).send({});
    expect(res.status).toBe(200);
    crId = res.body.changeRequest.id;
    expect(res.body.changeRequest.origin).toEqual({ type: 'fork', forkId: res.body.fork.id, forkSlug: 'volunteer-hours' });
    expect(res.body.changeRequest.ops.length).toBe(3);
    expect(res.body.changeRequest.classification.level).toBe('minor');
    expect(res.body.changeRequest.title).toMatch(/vol:VolunteeringActivity/);
    expect(res.body.fork.status).toBe('proposed');
    expect(res.body.fork.terms.every((t: { upstream: string }) => t.upstream === 'pending')).toBe(true);
    // Proposing again updates the same request rather than opening another.
    const again = await dev.post(`${forkPath}/propose`).send({});
    expect(again.body.changeRequest.id).toBe(crId);
    const forks = await reader.get('/api/ontologies/volunteering/forks');
    expect(forks.body.map((f: { slug: string }) => f.slug)).toContain('volunteer-hours');
  });

  it('a second fork falls behind when the first one merges, and syncs', async () => {
    const res = await dev.post('/api/ontologies/volunteering/forks').send({ name: 'Volunteer hours' });
    expect(res.body.slug).toBe('volunteer-hours-2');
    const steward = await login('steward', 'Steward Sol');
    const reviewer = await login('reviewer', 'Reviewer Ren');
    await reviewer.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'approve' });
    await steward.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'approve' });
    await steward.post('/api/simulation/clock').send({ advanceDays: 8 });
    const cr = await steward.get(`/api/change-requests/${crId}`);
    expect(cr.body.status).toBe('merged');

    const merged = await dev.get(`${forkPath}/check`);
    expect(merged.body.outcome).toBe('switch-to-draft');
    expect(merged.body.fork.status).toBe('merged');
    expect(merged.body.fork.terms.every((t: { upstream: string }) => t.upstream === 'merged')).toBe(true);
    expect(merged.body.replace[0].to).toMatch(/\/def\/volunteering\/draft$/);

    const behind = await dev.get('/api/ontologies/volunteering/forks/volunteer-hours-2/check');
    expect(behind.body.outcome).toBe('sync-fork');
    const synced = await dev.post('/api/ontologies/volunteering/forks/volunteer-hours-2/sync');
    expect(synced.body.synced).toBe(true);
    expect(synced.body.fork.behindBy).toBe(0);
    const ttl = await request(app).get('/def/volunteering/forks/volunteer-hours-2.ttl');
    expect(ttl.text).toMatch(/vol:VolunteeringActivity/);

    // The first fork's edits are all upstream now: syncing skips them.
    const s1 = await dev.post(`${forkPath}/sync`);
    expect(s1.body.synced).toBe(true);
    expect(s1.body.message).toMatch(/Already upstream: vol:VolunteeringActivity/);

    // Release, and the plan becomes: switch to the release.
    await steward.post('/api/ontologies/volunteering/releases').send({});
    const rels = await steward.get('/api/ontologies/volunteering/releases');
    const draft = rels.body.find((r: { status: string }) => r.status === 'draft' || r.status === 'voting');
    const published = await steward.post(`/api/releases/${draft.id}/publish`);
    expect(published.body.status).toBe('published');
    const released = await dev.get(`${forkPath}/check`);
    expect(released.body.outcome).toBe('switch-to-release');
    expect(released.body.fork.terms[0]).toMatchObject({ upstream: 'released', releasedIn: '1.1.0' });
    expect(released.body.replace).toContainEqual({ from: expect.stringMatching(/volunteer-hours$/), to: expect.stringMatching(/\/def\/volunteering\/1\.1\.0$/) });
    expect(released.body.replace).toContainEqual({ from: expect.stringMatching(/volunteer-hours\.ttl$/), to: expect.stringMatching(/\/def\/volunteering\/1\.1\.0\.ttl$/) });
    // Every URL the plan points to resolves, with the fork's terms in it.
    for (const { to } of released.body.replace) {
      const res = await request(app).get(new URL(to).pathname);
      expect(res.status, to).toBe(200);
      expect(res.text, to).toMatch(/VolunteeringActivity/);
    }

    const closed = await dev.post(`${forkPath}/close`);
    expect(closed.body.status).toBe('closed');
    // Closed forks keep resolving, so nothing that imports them breaks.
    expect((await request(app).get('/def/volunteering/forks/volunteer-hours.ttl')).status).toBe(200);
  });
});

describe('fork tools over MCP', () => {
  it('creates, edits, proposes and checks a fork', async () => {
    const tester = await login('contributor', 'Agent Ava');
    const tok = await tester.post('/api/agent-tokens').send({ name: 'Claude Code' });
    let id = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${tok.body.token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
      const raw = res.text.includes('data:') ? res.text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : res.text;
      const body = JSON.parse(raw);
      const text = body.result.content[0].text as string;
      return { isError: !!body.result.isError, text, json: () => JSON.parse(text) };
    };
    const tools = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tok.body.token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
    for (const t of ['create_fork', 'edit_fork', 'propose_fork', 'check_forks', 'sync_fork', 'list_forks', 'get_fork', 'close_fork', 'discard_fork_changes']) expect(tools.text).toContain(`"${t}"`);

    const none = await call('check_forks', {});
    expect(none.text).toMatch(/no forks/);

    const created = (await call('create_fork', { ontology: 'volunteering', name: 'Badges', purpose: 'Awarding badges for volunteer hours' })).json();
    expect(created.fork).toBe('volunteering/badges');
    expect(created.importUrls.turtle).toMatch(/\/def\/volunteering\/forks\/badges\.ttl$/);
    expect(created.howToImport).toMatch(/check_forks/);

    const edited = await call('edit_fork', { fork: 'volunteering/badges', description: 'Add a class called Badge as a subclass of vol:Skill' });
    expect(edited.isError).toBe(false);
    expect(edited.json().added[0].term).toBe('vol:Badge');

    const proposed = (await call('propose_fork', { fork: created.id })).json();
    expect(proposed.changeRequest.number).toBeGreaterThan(0);
    expect(proposed.changeRequest.url).toMatch(/\/o\/volunteering\/changes\/cr_/);

    const checks = (await call('check_forks', {})).json();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ fork: 'volunteering/badges', outcome: 'keep-using-fork' });
    expect(checks[0].terms[0]).toMatchObject({ term: 'vol:Badge', upstream: 'pending' });

    const missing = await call('get_fork', { fork: 'volunteering/nope' });
    expect(missing.isError).toBe(true);
  });
});
