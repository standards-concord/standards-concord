import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, put } from '../src/db.js';
import { DEMO_AVATAR_COUNT, demoAvatarUrl, personaAvatarUrl } from '../src/services/avatars.js';
import { PERSONAS } from '../src/services/personas.js';
import { seedDemo } from '../src/services/simulation.js';
import { backfillDemoAvatars, createUser, getUser } from '../src/services/users.js';

// The pictures are static files in the web app, so a URL the server hands out must name a file that exists.
const publicDir = path.join(config.repoRoot, 'apps/web/public');
const fileFor = (url: string) => path.join(publicDir, url);

beforeAll(async () => {
  openDb();
  await seedDemo();
});

describe('demo profile pictures', () => {
  it('has a bundled picture for every simulated person and every slot in the tester pool', () => {
    for (const p of PERSONAS) expect(fs.existsSync(fileFor(personaAvatarUrl(p.key))), p.key).toBe(true);
    const pool = fs.readdirSync(path.join(publicDir, 'avatars/demo')).filter((f) => f.endsWith('.svg'));
    expect(pool).toHaveLength(DEMO_AVATAR_COUNT);
  });

  it('gives each simulated person their own picture', async () => {
    const res = await request(createApp()).get('/api/personas');
    expect(res.status).toBe(200);
    for (const p of res.body as { key: string; avatarUrl?: string }[]) expect(p.avatarUrl).toBe(personaAvatarUrl(p.key));
  });

  it('gives a new tester a stable picture from the pool, and leaves real sign-ins alone', async () => {
    const agent = request.agent(createApp());
    const res = await agent.post('/api/auth/demo').send({ name: 'Picture tester', role: 'member' });
    expect(res.status).toBe(200);
    const url = res.body.user.avatarUrl as string;
    expect(url).toBe(demoAvatarUrl(res.body.user.id));
    expect(fs.existsSync(fileFor(url))).toBe(true);

    const google = await createUser({ name: 'Real person', provider: 'google', subject: 'g-123' });
    expect(google.avatarUrl).toBeUndefined();
  });

  it('spreads testers across the pool', () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => demoAvatarUrl(`usr_${i}`)));
    expect(used.size).toBeGreaterThan(DEMO_AVATAR_COUNT * 0.75);
  });

  it('backfills demo accounts made before pictures existed', async () => {
    const old = await createUser({ name: 'Old tester', provider: 'demo', subject: 'tester_old' });
    put<User>('users', { ...old, avatarUrl: undefined });
    expect(backfillDemoAvatars()).toBeGreaterThanOrEqual(1);
    expect(getUser(old.id)?.avatarUrl).toBe(demoAvatarUrl(old.id));
  });
});
