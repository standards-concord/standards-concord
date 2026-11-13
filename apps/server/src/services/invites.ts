import { createHash, randomBytes } from 'node:crypto';
import type { Invite, InviteInput, InviteLookup, InviteState, Role, User } from '@concord/shared';
import { addDays, clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, transaction } from '../db.js';
import { newId } from '../ids.js';
import { getProject, requireRole, rolesFor, setRoles } from './ontologies.js';
import { getUser, logActivity } from './users.js';
import { reconcile as reconcileAutopilot } from './appChecks.js';

export interface InviteDoc extends Omit<Invite, 'invitedBy' | 'state'> { hash: string }
const GRANTABLE: Role[] = ['steward', 'editor', 'reviewer', 'member', 'contributor', 'odi'];
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const indexId = (hash: string) => `invite:${hash}`;
const stateOf = (invite: InviteDoc): InviteState => invite.revokedAt ? 'revoked'
  : invite.expiresAt <= clock.iso() ? 'expired' : invite.uses >= invite.maxUses ? 'used up' : 'active';
const creatorName = async (invite: InviteDoc) => (await getUser(invite.createdBy))?.name ?? 'a former member';
async function publicInvite(invite: InviteDoc): Promise<Invite> {
  const { hash: _hash, ...record } = invite;
  return { ...record, invitedBy: await creatorName(invite), state: stateOf(invite) };
}
const integer = (value: unknown, fallback: number, max: number, name: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
    throw new HttpError(400, `${name} must be a whole number from 1 to ${max}.`);
  return value;
};

export async function createInvite(ontologyId: string, creator: User, input: InviteInput) {
  return transaction(async () => {
    await getProject(ontologyId);
    await requireRole(ontologyId, creator, ['owner', 'steward'], 'invite people');
    if (!Array.isArray(input.roles) || !input.roles.length || input.roles.some((r) => !GRANTABLE.includes(r)))
      throw new HttpError(400, 'Choose at least one role. Invitations cannot grant ownership or agent access.');
    // Existing membership management lets stewards grant stewardship. ODI invitations need ODI authority.
    if (input.roles.includes('odi') && !creator.isPlatformAdmin && !(await rolesFor(ontologyId, creator.id)).includes('odi'))
      throw new HttpError(403, 'Only someone with ODI oversight can invite someone with ODI oversight.');
    const expiresInDays = integer(input.expiresInDays, 7, 30, 'Link duration');
    const maxUses = integer(input.maxUses, 1, 50, 'Maximum uses');
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 120))
      throw new HttpError(400, 'The note must be at most 120 characters.');
    const secret = randomBytes(32).toString('base64url');
    const hash = digest(secret);
    const createdAt = clock.iso();
    const doc: InviteDoc = {
      id: newId('inv'), ontologyId, roles: [...new Set(input.roles)], createdBy: creator.id, createdAt,
      expiresAt: addDays(createdAt, expiresInDays), maxUses, uses: 0, usedBy: [], note: input.note?.trim() || undefined, hash,
    };
    await put('invites', doc, ontologyId);
    // Direct hash lookup avoids scanning stored secrets or comparing their values. The index contains no secret.
    await put('kv', { id: indexId(hash), inviteId: doc.id, ontologyId }, ontologyId);
    return { invite: await publicInvite(doc), link: `${config.webUrl}/join/${secret}` };
  });
}

export async function listInvites(ontologyId: string, actor: User) {
  await requireRole(ontologyId, actor, ['owner', 'steward'], 'view invitation links');
  return Promise.all((await list<InviteDoc>('invites', ontologyId)).reverse().map(publicInvite));
}
export async function revokeInvite(ontologyId: string, id: string, actor: User) {
  return transaction(async () => {
    await requireRole(ontologyId, actor, ['owner', 'steward'], 'revoke invitation links');
    const doc = await get<InviteDoc>('invites', id);
    if (!doc || doc.ontologyId !== ontologyId) throw new HttpError(404, 'Invitation not found.');
    doc.revokedAt ??= clock.iso();
    await put('invites', doc, ontologyId);
  });
}

async function findInvite(secret: string) {
  // Malformed and unknown links do the same fixed-size hash lookup and receive the same answer.
  const key = /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : '';
  const index = await get<{ inviteId: string }>('kv', indexId(digest(key)));
  const doc = index ? await get<InviteDoc>('invites', index.inviteId) : undefined;
  if (!doc || !await get('ontologies', doc.ontologyId)) throw new HttpError(404, 'This invitation link is not valid.');
  return doc;
}
async function lookup(doc: InviteDoc): Promise<InviteLookup> {
  const { id, title, slug } = await getProject(doc.ontologyId);
  return { ontology: { id, title, slug }, roles: doc.roles, invitedBy: await creatorName(doc), expiresAt: doc.expiresAt, state: stateOf(doc) };
}
/** Public details on a known inactive link let the page still link to the standard. */
export async function lookupInvite(secret: string) {
  const info = await lookup(await findInvite(secret));
  return { info, status: info.state === 'active' ? 200 : 410 };
}
export const inactiveMessage = (state: InviteState) => `This invitation link has ${state === 'used up' ? 'been used up' : state === 'revoked' ? 'been revoked' : 'expired'}.`;

export async function acceptInvite(secret: string, actor: User) {
  const result = await transaction(async () => {
    const doc = await findInvite(secret);
    const existing = await rolesFor(doc.ontologyId, actor.id);
    if (actor.simulated || existing.includes('agent'))
      throw new HttpError(403, 'Sign in with your own account to accept this invitation. Simulated members and agents cannot join.');
    const state = stateOf(doc);
    // An inactive link can only acknowledge roles already held; it must never restore removed privileges.
    if (doc.roles.every((role) => existing.includes(role))) return { ontologyId: doc.ontologyId };
    if (state !== 'active') throw new HttpError(410, inactiveMessage(state));
    const alreadyUsed = doc.usedBy.some((use) => use.userId === actor.id);
    await setRoles(doc.ontologyId, actor.id, [...existing, ...doc.roles]);
    if (!alreadyUsed) {
      doc.uses++;
      doc.usedBy.push({ userId: actor.id, at: clock.iso() });
      await put('invites', doc, doc.ontologyId);
      await logActivity({ ontologyId: doc.ontologyId, actorId: actor.id, type: 'member.joined',
        message: `joined as ${doc.roles.join(', ')}, invited by ${await creatorName(doc)}`, link: `/o/${doc.ontologyId}/governance#roles` });
    }
    return { ontologyId: doc.ontologyId };
  });
  // Reconciliation may run checks and take their locks, so it follows the membership transaction. A retry
  // that finds the roles already held runs it again: the first attempt may have failed after saving them.
  await reconcileAutopilot(result.ontologyId, [actor.id]);
  return result;
}
