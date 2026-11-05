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
  /** Their own WebID (signed in with Solid). They still get a pod here for what Concord saves for them. */
  webId?: string;
}): Promise<User> {
  const id = input.id ?? newId('usr');
  const base: User = {
    id,
    name: input.name,
    email: input.email,
    avatarUrl: input.avatarUrl,
    webId: input.webId ?? solid.localWebId(id),
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
    base.webId = input.webId ?? webId;
    base.podUrl = podUrl;
  } catch (err) {
    console.warn(`[solid] could not provision pod for ${base.name}: ${(err as Error).message}`);
  }
  return await put('users', base);
}

export async function findByProvider(provider: AuthProvider, subject: string): Promise<User | undefined> {
  return (await list<User>('users')).find((u) => u.providers.some((p) => p.provider === provider && p.subject === subject));
}

/**
 * Find or create the account for a Google or GitHub identity. Sign-in is by
 * provider and subject only: matching on email would let a new identity that
 * merely shares an address take over an existing account.
 *
 * `linkTo` is the demo tester account the same browser was using (the caller has
 * checked the OAuth state, so the browser started this sign-in). When the
 * identity is new it is attached to that account, so what they saved stays theirs.
 */
export async function upsertFederatedUser(p: { provider: AuthProvider; subject: string; name: string; email?: string; avatarUrl?: string; webId?: string }, linkTo?: User) {
  // Looked up and attached in one transaction, so two sign-ins at once can't both find the identity unattached
  // (and attach it to two accounts), nor both attach to one account from copies read before the other saved.
  const found = await transaction(async () => {
    const existing = await findByProvider(p.provider, p.subject);
    if (!existing && linkTo) {
      // Re-read: whether it is still a demo-only account is decided on the stored copy, not the caller's.
      const linked = await get<User>('users', linkTo.id);
      // Another sign-in from this browser attached an identity to it a moment ago. Making a new account here would
      // have the caller move the demo account's testing record into it, closing the record the other identity now
      // holds, so this sign-in is refused instead; signing in again starts from the account as it now is.
      if (linked && !linked.simulated && !linked.providers.every((x) => x.provider === 'demo'))
        throw new HttpError(409, 'This browser’s demo account was just linked to another sign-in. Please sign in again.');
      if (linked && !linked.simulated) {
        linked.providers.push({ provider: p.provider, subject: p.subject });
        linked.name = p.name;
        // Signing in with their own WebID makes it the account's WebID.
        if (p.webId) linked.webId = p.webId;
        linked.email ??= p.email;
        linked.avatarUrl ??= p.avatarUrl;
        // Sessions issued while it was a demo account (in any browser) end here.
        await destroyUserSessions(linked.id);
        return await put('users', linked);
      }
    }
    if (existing) {
      if (!existing.providers.some((x) => x.provider === p.provider)) existing.providers.push({ provider: p.provider, subject: p.subject });
      existing.avatarUrl ??= p.avatarUrl;
      return await put('users', existing);
    }
    return undefined;
  });
  // A new account is made outside it: making one provisions a pod over the network.
  return found ?? createUser({ ...p });
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
  /**
   * How this session was signed in. Administrator access needs a session that
   * was itself signed in with Google or GitHub: an account that later gains a
   * provider does not upgrade the sessions it already had.
   */
  method?: AuthProvider;
  createdAt: string;
}

export async function createSession(userId: string, method?: AuthProvider): Promise<string> {
  const id = newToken();
  await put<SessionDoc>('sessions', { id: hash(id), userId, method, createdAt: new Date().toISOString() });
  return id;
}
export async function sessionOf(token: string | undefined): Promise<{ user: User; method?: AuthProvider } | undefined> {
  if (!token) return;
  const s = await get<SessionDoc>('sessions', hash(token));
  const user = s && await getUser(s.userId);
  return user ? { user, method: s.method } : undefined;
}
export async function sessionUser(token: string | undefined): Promise<User | undefined> {
  return (await sessionOf(token))?.user;
}
/** End every session an account has (for example when a demo account gains a Google or GitHub identity). */
export async function destroyUserSessions(userId: string) { return transaction(async () => {
  for (const s of await list<SessionDoc>('sessions')) if (s.userId === userId) await remove('sessions', s.id);
}); }
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

/** The author of reports sent from the public page by people without an account. */
export async function publicReporter(): Promise<User> {
  const id = 'usr_public';
  return (
    await getUser(id) ??
    await put('users', { id, name: 'Member of the public', webId: solid.localWebId(id), providers: [], simulated: true, createdAt: clock.iso() } satisfies User)
  );
}
