import { createHash } from 'node:crypto';
import type { ActivityItem, AgentToken, AuthProvider, User } from '@concord/shared';
import { clock } from '../clock.js';
import { transaction, get, HttpError, list, put, remove } from '../db.js';
import { newId, newToken } from '../ids.js';
import { solid } from './solid.js';

export async function createUser(input: {
  name: string;
  email?: string;
  avatarUrl?: string;
  provider: AuthProvider;
  subject: string;
  simulated?: boolean;
  persona?: string;
  organisation?: string;
  id?: string;
  isPlatformAdmin?: boolean;
}): Promise<User> {
  const id = input.id ?? newId('usr');
  const base: User = {
    id,
    name: input.name,
    email: input.email,
    avatarUrl: input.avatarUrl,
    webId: solid.localWebId(id),
    providers: [{ provider: input.provider, subject: input.subject }],
    simulated: input.simulated,
    persona: input.persona,
    organisation: input.organisation,
    isPlatformAdmin: input.isPlatformAdmin,
    createdAt: clock.iso(),
  };
  // Every account gets a WebID and pod without having to know about Solid.
  try {
    const { webId, podUrl } = await solid.provision(base);
    base.webId = webId;
    base.podUrl = podUrl;
  } catch (err) {
    console.warn(`[solid] could not provision pod for ${base.name}: ${(err as Error).message}`);
  }
  return await put('users', base);
}

export async function findByProvider(provider: AuthProvider, subject: string): Promise<User | undefined> {
  return (await list<User>('users')).find((u) => u.providers.some((p) => p.provider === provider && p.subject === subject));
}

export async function upsertFederatedUser(p: { provider: AuthProvider; subject: string; name: string; email?: string; avatarUrl?: string }) {
  // Sign-in is by provider and subject only. Matching on email would let a new
  // identity that merely shares an address take over an existing account.
  const existing = await findByProvider(p.provider, p.subject);
  if (existing) {
    if (!existing.providers.some((x) => x.provider === p.provider)) existing.providers.push({ provider: p.provider, subject: p.subject });
    existing.avatarUrl ??= p.avatarUrl;
    return await put('users', existing);
  }
  return createUser({ ...p });
}

export const getUser = async (id: string) => await get<User>('users', id);
export const allUsers = async () => await list<User>('users');
export const personas = async () => (await allUsers()).filter((u) => u.simulated);

export const publicUser = (u?: User) => (u ? { id: u.id, name: u.name, avatarUrl: u.avatarUrl, simulated: u.simulated } : undefined);

/* ------------------------------------------------------------------------ */
/* Browser sessions                                                          */
/* ------------------------------------------------------------------------ */

interface SessionDoc {
  id: string;
  userId: string;
  createdAt: string;
}

export async function createSession(userId: string): Promise<string> {
  const id = newToken();
  await put<SessionDoc>('sessions', { id: hash(id), userId, createdAt: new Date().toISOString() });
  return id;
}
export async function sessionUser(token: string | undefined): Promise<User | undefined> {
  if (!token) return;
  const s = await get<SessionDoc>('sessions', hash(token));
  return s ? await getUser(s.userId) : undefined;
}
export async function destroySession(token: string | undefined) {
  if (token) await remove('sessions', hash(token));
}

/* ------------------------------------------------------------------------ */
/* Agent (MCP) tokens                                                        */
/* ------------------------------------------------------------------------ */

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

interface AgentTokenDoc extends AgentToken {
  hash: string;
}

export async function createAgentToken(userId: string, name: string): Promise<AgentToken> {
  const token = newToken();
  const doc: AgentTokenDoc = { id: newId('tok'), userId, name, prefix: token.slice(0, 10), hash: hash(token), createdAt: clock.iso() };
  await put('agentTokens', doc, userId);
  const { hash: _h, ...rest } = doc;
  return { ...rest, token };
}
export async function listAgentTokens(userId: string): Promise<AgentToken[]> {
  return (await list<AgentTokenDoc>('agentTokens', userId)).map(({ hash: _h, ...rest }) => rest);
}
export async function deleteAgentToken(userId: string, id: string) { return transaction(async () => {
  const t = await get<AgentTokenDoc>('agentTokens', id);
  if (!t || t.userId !== userId) throw new HttpError(404, 'Token not found');
  await remove('agentTokens', id);
}); }
export async function userForAgentToken(token: string): Promise<{ user: User; tokenName: string } | undefined> { return transaction(async () => {
  const h = hash(token);
  const t = (await list<AgentTokenDoc>('agentTokens')).find((x) => x.hash === h);
  if (!t) return;
  t.lastUsedAt = clock.iso();
  await put('agentTokens', t, t.userId);
  const user = await getUser(t.userId);
  return user ? { user, tokenName: t.name } : undefined;
}); }

/* ------------------------------------------------------------------------ */
/* Activity feed                                                             */
/* ------------------------------------------------------------------------ */

export async function logActivity(a: Omit<ActivityItem, 'id' | 'at' | 'actorName' | 'simulated'> & { at?: string }): Promise<ActivityItem> { return transaction(async () => {
  const actor = a.actorId ? await getUser(a.actorId) : undefined;
  const item: ActivityItem = { id: newId('act'), at: a.at ?? clock.iso(), actorName: actor?.name, simulated: actor?.simulated, ...a };
  return await put('activity', item, a.ontologyId ?? 'global');
}); }

export async function listActivity(ontologyId?: string, limit = 50): Promise<ActivityItem[]> {
  const items = ontologyId ? await list<ActivityItem>('activity', ontologyId) : await list<ActivityItem>('activity');
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
