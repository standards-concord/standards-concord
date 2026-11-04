import { createHash } from 'node:crypto';
import type { ActivityItem, AgentToken, AuthProvider, User } from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { newId, newToken } from '../ids.js';
import { demoAvatarFor } from './avatars.js';
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
  const providers = [{ provider: input.provider, subject: input.subject }];
  const base: User = {
    id,
    name: input.name,
    email: input.email,
    // Demo accounts (simulated people and alpha testers) get a bundled picture.
    avatarUrl: input.avatarUrl ?? demoAvatarFor({ id, providers }),
    webId: solid.localWebId(id),
    providers,
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
  return put('users', base);
}

export function findByProvider(provider: AuthProvider, subject: string): User | undefined {
  return list<User>('users').find((u) => u.providers.some((p) => p.provider === provider && p.subject === subject));
}

export async function upsertFederatedUser(p: { provider: AuthProvider; subject: string; name: string; email?: string; avatarUrl?: string }) {
  // Sign-in is by provider and subject only. Matching on email would let a new
  // identity that merely shares an address take over an existing account.
  const existing = findByProvider(p.provider, p.subject);
  if (existing) {
    if (!existing.providers.some((x) => x.provider === p.provider)) existing.providers.push({ provider: p.provider, subject: p.subject });
    existing.avatarUrl ??= p.avatarUrl;
    return put('users', existing);
  }
  return createUser({ ...p });
}

/** Gives demo accounts made before profile pictures existed their picture. Returns how many changed. */
export function backfillDemoAvatars(): number {
  let changed = 0;
  for (const u of list<User>('users')) {
    if (u.avatarUrl) continue;
    const avatarUrl = demoAvatarFor(u);
    if (!avatarUrl) continue;
    put('users', { ...u, avatarUrl });
    changed++;
  }
  return changed;
}

export const getUser = (id: string) => get<User>('users', id);
export const allUsers = () => list<User>('users');
export const personas = () => allUsers().filter((u) => u.simulated);

export const publicUser = (u?: User) => (u ? { id: u.id, name: u.name, avatarUrl: u.avatarUrl, simulated: u.simulated } : undefined);

/* ------------------------------------------------------------------------ */
/* Browser sessions                                                          */
/* ------------------------------------------------------------------------ */

interface SessionDoc {
  id: string;
  userId: string;
  createdAt: string;
}

export function createSession(userId: string): string {
  const id = newToken();
  put<SessionDoc>('sessions', { id: hash(id), userId, createdAt: new Date().toISOString() });
  return id;
}
export function sessionUser(token: string | undefined): User | undefined {
  if (!token) return;
  const s = get<SessionDoc>('sessions', hash(token));
  return s ? getUser(s.userId) : undefined;
}
export function destroySession(token: string | undefined) {
  if (token) remove('sessions', hash(token));
}

/* ------------------------------------------------------------------------ */
/* Agent (MCP) tokens                                                        */
/* ------------------------------------------------------------------------ */

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

interface AgentTokenDoc extends AgentToken {
  hash: string;
}

export function createAgentToken(userId: string, name: string): AgentToken {
  const token = newToken();
  const doc: AgentTokenDoc = { id: newId('tok'), userId, name, prefix: token.slice(0, 10), hash: hash(token), createdAt: clock.iso() };
  put('agentTokens', doc, userId);
  const { hash: _h, ...rest } = doc;
  return { ...rest, token };
}
export function listAgentTokens(userId: string): AgentToken[] {
  return list<AgentTokenDoc>('agentTokens', userId).map(({ hash: _h, ...rest }) => rest);
}
export function deleteAgentToken(userId: string, id: string) {
  const t = get<AgentTokenDoc>('agentTokens', id);
  if (!t || t.userId !== userId) throw new HttpError(404, 'Token not found');
  remove('agentTokens', id);
}
export function userForAgentToken(token: string): { user: User; tokenName: string } | undefined {
  const h = hash(token);
  const t = list<AgentTokenDoc>('agentTokens').find((x) => x.hash === h);
  if (!t) return;
  t.lastUsedAt = clock.iso();
  put('agentTokens', t, t.userId);
  const user = getUser(t.userId);
  return user ? { user, tokenName: t.name } : undefined;
}

/* ------------------------------------------------------------------------ */
/* Activity feed                                                             */
/* ------------------------------------------------------------------------ */

export function logActivity(a: Omit<ActivityItem, 'id' | 'at' | 'actorName' | 'simulated'> & { at?: string }): ActivityItem {
  const actor = a.actorId ? getUser(a.actorId) : undefined;
  const item: ActivityItem = { id: newId('act'), at: a.at ?? clock.iso(), actorName: actor?.name, simulated: actor?.simulated, ...a };
  return put('activity', item, a.ontologyId ?? 'global');
}

export function listActivity(ontologyId?: string, limit = 50): ActivityItem[] {
  const items = ontologyId ? list<ActivityItem>('activity', ontologyId) : list<ActivityItem>('activity');
  // The picture is looked up when read, so older entries and changed pictures show too.
  return items
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((a) => ({ ...a, actorAvatarUrl: a.actorId ? getUser(a.actorId)?.avatarUrl : undefined }));
}
