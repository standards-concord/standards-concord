import { useState, type ReactNode } from 'react';
import { ROLE_INFO, type Role } from '@concord/shared';
import { api } from '../../api';
import { Disclosure } from '../../components/Disclosure';
import { Button, CopyButton, Field, InlineError, Input, Loading, Select } from '../../components/ui';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate, plural, relativeTime, roleLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useOntology } from './Layout';

export function InvitationLinks({ children }: { children?: ReactNode }) {
  const { id, hasRole } = useOntology();
  const { now } = useSession();
  // Invitations are deliberately never kept in the offline store.
  const links = useAsync(() => api.invites(id), [id]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(1);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string>();
  const create = useAction(async () => {
    const result = await api.createInvite(id, { roles, expiresInDays: days, maxUses: uses, note });
    setLink(result.link);
    await links.reload();
  });
  const revoke = useAction(async (inviteId: string) => {
    await api.revokeInvite(id, inviteId);
    await links.reload();
  });
  const grantable: Role[] = ['steward', 'editor', 'reviewer', 'member', 'contributor', ...(hasRole('odi') ? ['odi' as const] : [])];
  const active = (links.data ?? []).filter((invite) => invite.state === 'active' && new Date(invite.expiresAt).getTime() > now()).length;
  return (
    <Disclosure className="border-t border-line px-5 py-4" title="Invite people" summary={active ? plural(active, 'active link') : undefined}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void create.run(); }}>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Roles</legend>
          {grantable.map((role) => (
            <label className="flex items-start gap-2 text-sm" key={role}>
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-accent" aria-label={ROLE_INFO[role].label}
                checked={roles.includes(role)} onChange={(event) => setRoles(event.target.checked ? [...roles, role] : roles.filter((r) => r !== role))} />
              <span><span className="font-medium">{ROLE_INFO[role].label}</span><span className="block text-xs text-muted">{ROLE_INFO[role].description}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <Field label="Link works for"><Select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option>
          </Select></Field>
          <Field label="Can be used"><Select value={uses} onChange={(event) => setUses(Number(event.target.value))}>
            <option value={1}>Once</option><option value={5}>5 times</option><option value={25}>25 times</option>
          </Select></Field>
        </div>
        <Field label="Note (optional)"><Input maxLength={120} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reviewers from the pilot councils" /></Field>
        <Button type="submit" disabled={!roles.length} loading={create.pending}>Create invitation link</Button>
        <InlineError error={create.error} />
      </form>
      {link && <div className="mt-4 space-y-3" role="status">
        <Field label="Invitation link"><Input readOnly value={link} onFocus={(event) => event.target.select()} /></Field>
        <CopyButton text={link} label="Copy link" />
        <p className="text-sm text-muted">Send this link to the people you want to invite. Anyone who has it can join with these roles until it expires, so share it privately. You won't be able to see the link again.</p>
      </div>}
      <section className="mt-6" aria-labelledby="invitation-links-title">
        <h3 id="invitation-links-title" className="text-sm font-semibold">Invitation links</h3>
        {links.loading && !links.data && <Loading />}
        <InlineError error={links.error || revoke.error} />
        {links.data?.length === 0 && <p className="mt-2 text-sm text-muted">No invitation links yet.</p>}
        <ul aria-label="Invitation links" className="divide-y divide-line">
          {links.data?.map((invite) => {
            const daysLeft = Math.max(0, Math.ceil((new Date(invite.expiresAt).getTime() - now()) / 86_400_000));
            const state = invite.state === 'active' && !daysLeft ? 'expired' : invite.state;
            return <li key={invite.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-1 break-words">
                <p>{invite.roles.map(roleLabel).join(', ')}{invite.note ? `: ${invite.note}` : ''}</p>
                <p className="text-xs text-muted">Created by {invite.invitedBy} {relativeTime(invite.createdAt, now())}</p>
                <p className="text-xs text-muted">used {invite.uses} of {invite.maxUses} · expires in {plural(daysLeft, 'day')} <span title={formatDate(invite.expiresAt)}>({formatDate(invite.expiresAt)})</span></p>
                <p>{state === 'active' ? 'Active' : state === 'used up' ? 'Used up' : state === 'revoked' ? 'Revoked' : 'Expired'}</p>
              </div>
              {state !== 'revoked' && <Button size="sm" loading={revoke.pending} onClick={() => confirm('Revoke this invitation link? It will stop working immediately.') && void revoke.run(invite.id)}>Revoke</Button>}
            </li>;
          })}
        </ul>
      </section>
      {children}
    </Disclosure>
  );
}
