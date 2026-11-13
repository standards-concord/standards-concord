import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_VOCABULARIES } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, remove } from '../src/db.js';
import { findProject } from '../src/services/ontologies.js';
import { seedSamples } from '../src/services/samples.js';
import * as samples from '../src/services/samples.js';
import { runStartupTasks } from '../src/startup.js';

const app = createApp();
beforeAll(async () => { await openDb(); await seedSamples(); });

describe('samples through the API and MCP', () => {
  it('returns attribution on public lists and project details', async () => {
    const all = await request(app).get('/api/ontologies');
    expect(all.status).toBe(200);
    for (const s of SAMPLE_VOCABULARIES) {
      const row = all.body.find((p: { slug: string }) => p.slug === s.slug);
      expect(row.sample).toMatchObject({ source: s.source, publisher: s.publisher, licence: s.licence, changes: s.changes, usedBy: s.usedBy });
      const detail = await request(app).get(`/api/ontologies/${s.slug}`);
      expect(detail.status).toBe(200);
      expect(detail.body.sample).toEqual(row.sample);
    }
  });

  it('serves the released public page and original namespace terms anonymously', async () => {
    const page = await request(app).get('/def/acl/1.0.0').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('aria-label="About this sample"');
    expect(page.text).toContain('http://www.w3.org/ns/auth/acl');
    expect(page.text).toContain('W3C Software and Document License (2015)');
    expect(page.text).toContain('href="/licences/W3C-20150513"');
    const notice = await request(app).get('/licences/W3C-20150513');
    expect(notice.status).toBe(200);
    expect(notice.text).toContain('COPYRIGHT HOLDERS WILL NOT BE LIABLE');
    const markdown = await request(app).get('/docs/licences/CC-BY-1.0.md');
    expect(markdown.status).toBe(200);
    expect(markdown.text).toContain('Creative Commons Attribution 1.0');
    const source = await request(app).get('/def/acl/1.0.0.ttl');
    expect(source.status).toBe(200);
    expect(source.text).toContain('acl:Authorization');
    expect(source.text).toContain('acl:agent');
    expect(source.text).toContain('Copyright (c) W3C® (MIT, ERCIM, Keio, Beihang).');
    expect(source.text).toContain('COPYRIGHT HOLDERS WILL NOT BE LIABLE');
    expect(source.text).toContain('https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document');
  });

  it('does not give a demo tester ownership of a sample; they may propose a change', async () => {
    const tester = request.agent(app);
    const signedIn = await tester.post('/api/auth/demo').send({ name: 'Sample API tester', role: 'steward' });
    expect(signedIn.status).toBe(200);
    const acl = (await findProject('acl'))!;
    const detail = await tester.get(`/api/ontologies/${acl.id}`);
    const membership = detail.body.members.find((m: { userId: string }) => m.userId === signedIn.body.user.id);
    expect(membership?.roles ?? []).not.toContain('steward');
    expect(detail.body.ownerIds).not.toContain(signedIn.body.user.id);
    const forbidden = await tester.put(`/api/ontologies/${acl.id}/governance`).send(acl.governance);
    expect(forbidden.status).toBe(403);
    const proposal = await tester.post(`/api/ontologies/${acl.id}/change-requests`).send({
      title: 'Explain agent permissions', description: 'A proposal for the sample working group.',
      kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: `${acl.namespace}agent`, set: { comment: 'Proposed wording for review.' } }],
    });
    expect(proposal.status).toBe(201);
    const term = await tester.get(`/api/ontologies/${acl.id}/terms/${encodeURIComponent(acl.namespace + 'agent')}`);
    expect(JSON.stringify(term.body)).not.toContain('Proposed wording for review.');
  });

  it('MCP list_ontologies includes and marks all samples with their attribution', async () => {
    const tester = request.agent(app);
    await tester.post('/api/auth/demo').send({ name: 'Sample MCP tester', role: 'contributor' });
    const token = (await tester.post('/api/agent-tokens').send({ name: 'Sample test' })).body.token;
    const response = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_ontologies', arguments: {} } });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.text.includes('data:') ? response.text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : response.text);
    const rows = JSON.parse(payload.result.content[0].text);
    for (const s of SAMPLE_VOCABULARIES) expect(rows.find((row: { slug: string }) => row.slug === s.slug)).toMatchObject({ isSample: true, sample: { source: s.source, licence: s.licence } });
    expect(rows.find((row: { slug: string }) => row.slug === 'volunteering').isSample).toBe(false);
  });

  it('uses only sign-in as a sample-seed fallback until start-up has finished', async () => {
    const seed = vi.spyOn(samples, 'seedSamples');
    try {
      const ps = await request(app).get('/api/personas');
      expect(ps.status).toBe(200);
      expect(seed).not.toHaveBeenCalled();
      const cold = await request(app).post('/api/auth/demo').send({ name: 'Cold-start tester' });
      expect(cold.status).toBe(200);
      expect(seed).toHaveBeenCalledOnce();
      await runStartupTasks([{ name: 'sample-seed', run: async () => void await seedSamples() }]);
      seed.mockClear();
      const warm = await request(app).post('/api/auth/demo').send({ name: 'Warm-start tester' });
      expect(warm.status).toBe(200);
      expect(seed).not.toHaveBeenCalled();
    } finally {
      seed.mockRestore();
      await remove('kv', 'startup:sample-seed');
    }
  });
});
