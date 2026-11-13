import { Link, useNavigate, useParams } from 'react-router';
import { ROLE_INFO, type InviteLookup, type Role } from '@concord/shared';
import { api, ApiError } from '../api';
import { Button, ErrorCard, InlineError, Loading } from '../components/ui';
import { useAction, useAsync } from '../lib/hooks';
import { formatDate } from '../lib/format';
import { useSession } from '../lib/session';

function rolesInWords(roles: Role[]) {
  const words = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(roles.map((role) =>
    role === 'member' ? 'member' : role === 'odi' ? 'ODI oversight member' : ROLE_INFO[role].label.toLowerCase()));
  return `${roles[0] === 'editor' || roles[0] === 'odi' ? 'an' : 'a'} ${words}`;
}

export function JoinPage() {
  const { secret = '' } = useParams();
  const { session, loading } = useSession();
  const nav = useNavigate();
  // No keep key: the secret and lookup response never enter offline storage.
  const invite = useAsync(() => api.invite(secret), [secret]);
  const error = invite.error instanceof ApiError ? invite.error : undefined;
  const info = error?.status === 410 ? error.body as InviteLookup : invite.data;
  const join = useAction(async () => {
    const result = await api.acceptInvite(secret);
    nav(`/o/${result.ontologyId}`, { replace: true, state: { notice: `You've joined ${info!.ontology.title} as ${rolesInWords(info!.roles)}.` } });
  });
  const inactive = error?.status === 404 || error?.status === 410 || join.error instanceof ApiError && join.error.status === 410;
  return (
    <div className="mx-auto max-w-2xl break-words px-4 py-10 sm:px-6">
      {invite.loading || loading ? <Loading label="Checking invitation…" /> : inactive ? <>
        <h1 className="page-title">Invitation unavailable</h1>
        <p className="mt-4">{join.error instanceof ApiError && join.error.status === 410 ? join.error.message : error?.message}</p>
        <p className="mt-3">Ask whoever sent it for a new link.</p>
        {info ? <a className="mt-4 inline-block text-accent underline" href={`/def/${encodeURIComponent(info.ontology.slug)}`}>View {info.ontology.title}</a>
          : <Link className="mt-4 inline-block text-accent underline" to="/">Browse standards</Link>}
      </> : invite.error ? <ErrorCard error={invite.error} onRetry={() => void invite.reload()} /> : info ? <>
        <h1 className="page-title">You've been invited to join {info.ontology.title}</h1>
        <p className="mt-4">as {rolesInWords(info.roles)}</p>
        <p className="mt-3 text-sm text-muted">Invited by {info.invitedBy}. This link expires on {formatDate(info.expiresAt, true)}.</p>
        <div className="mt-6">
          {session?.user ? <Button variant="primary" loading={join.pending} onClick={() => void join.run()}>Join as {session.user.name}</Button>
            : <Link className="font-medium text-accent underline" to={`/login?next=${encodeURIComponent(`/join/${secret}`)}`}>Sign in to accept</Link>}
        </div>
        {!inactive && <InlineError error={join.error} />}
      </> : null}
    </div>
  );
}
