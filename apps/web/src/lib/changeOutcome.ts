import type { ChangeRequestDetail } from '@concord/shared';
import { formatDate, plural, roleLabel } from './format';

/** Read a closed request's decision from its history and the decisions that still stand. */
export function changeOutcome(cr: ChangeRequestDetail, name: (id?: string) => string | undefined): string | undefined {
  if (!['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status)) return undefined;
  const merged = cr.status === 'merged' || cr.status === 'released';
  const event = [...cr.timeline].reverse().find((e) => e.type === 'status' && (merged ? /^merged\b/.test(e.message) : cr.status === 'withdrawn' ? /withdrew|withdrawn/.test(e.message) : /^rejected\b/.test(e.message)));
  const at = event?.at ?? cr.statusSince;
  const date = formatDate(at);
  const who = (id?: string) => name(id) ?? 'a former member';
  const join = (ids: string[]) => new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(ids.map(who));
  if (cr.status === 'withdrawn') return `Withdrawn${event?.actorId ? ` by ${who(event.actorId)}` : ''} on ${date}.`;

  const latest = new Map<string, ChangeRequestDetail['reviews'][number]>();
  for (const r of [...cr.reviews].sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0))) {
    if (!r.stale && r.at <= at && r.decision !== 'comment') latest.set(r.userId, r);
  }
  const reviews = [...latest.values()].filter((r) => !r.withdrawnAt);
  const vetoes = reviews.filter((r) => ['object', 'request-changes'].includes(r.decision) && r.roles.some((role) => cr.governance.rule.vetoRoles.includes(role)));
  if (!merged && (event?.message.includes('vetoed') || cr.governance.vetoedBy.length)) {
    const veto = vetoes[0];
    if (veto) {
      const role = veto.roles.find((r) => cr.governance.rule.vetoRoles.includes(r))!;
      const label = role === 'odi' ? 'ODI' : roleLabel(role).toLowerCase();
      return `Rejected by ${who(veto.userId)} (${label} veto) on ${date}.`;
    }
    return `Rejected on ${date} after a veto.`;
  }
  const vote = cr.governance.vote;
  const tally = vote ? `${vote.yes} in favour, ${vote.no} against${vote.abstain ? `, ${plural(vote.abstain, 'abstention')}` : ''}` : '';
  if (!merged) return vote ? `Rejected by vote on ${date}: ${tally}.` : `Rejected on ${date}.`;
  if (cr.approvedAs?.voted && vote) return `Merged on ${date} after a vote: ${tally}.`;
  const signoffs = reviews.filter((r) => r.decision === 'approve' && r.roles.some((role) => cr.governance.rule.approverRoles.includes(role))).map((r) => r.userId);
  return `Merged on ${date}${signoffs.length ? ` after sign-off from ${join(signoffs)}` : ''}.`;
}
