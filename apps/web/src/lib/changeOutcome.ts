import type { ChangeRequestDetail } from '@concord/shared';
import { formatDate, plural, roleLabel } from './format';

/** Read a closed request's decision from its history, using recorded sign-offs when available. */
export function changeOutcome(cr: ChangeRequestDetail, name: (id?: string) => string | undefined): string | undefined {
  if (!['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status)) return undefined;
  const merged = cr.status === 'merged' || cr.status === 'released';
  const event = [...cr.timeline].reverse().find((e) => e.type === 'status' && (merged ? /^merged\b/.test(e.message) : cr.status === 'withdrawn' ? /withdrew|withdrawn/.test(e.message) : /^rejected\b/.test(e.message)));
  const at = event?.at ?? cr.statusSince;
  const date = formatDate(at);
  const who = (id?: string) => name(id) ?? 'a former member';
  if (cr.status === 'withdrawn') return `Withdrawn${event?.actorId ? ` by ${who(event.actorId)}` : ''} on ${date}.`;

  // Whether it was a veto is in the recorded decision. Today's roles only stand in for a record without one:
  // an objector given a veto role after a vote failed did not veto it.
  const vetoed = event ? event.message.includes('vetoed') : cr.governance.vetoedBy.length > 0;
  if (!merged && vetoed) {
    // Likewise the veto is the objection of someone who held a veto role when they made it. The evaluator's
    // list (which knows rounds and autopilot) picks among those; reviews saved without roles fall back to it.
    const objections = cr.reviews.filter((r) => r.decision === 'object');
    const held = objections.filter((r) => r.roles?.some((role) => cr.governance.rule.vetoRoles.includes(role)));
    const veto = held.find((r) => cr.governance.vetoedBy.includes(r.userId)) ?? held.at(-1) ?? objections.find((r) => cr.governance.vetoedBy.includes(r.userId));
    if (veto) {
      const role = veto.roles?.find((r) => cr.governance.rule.vetoRoles.includes(r));
      const label = role === 'odi' ? 'ODI' : role ? roleLabel(role).toLowerCase() : undefined;
      return `Rejected by ${who(veto.userId)} (${label ? `${label} ` : ''}veto) on ${date}.`;
    }
    return `Rejected on ${date} after a veto.`;
  }
  const vote = cr.governance.vote;
  const tally = vote ? `${vote.yes} in favour, ${vote.no} against${vote.abstain ? `, ${plural(vote.abstain, 'abstention')}` : ''}` : '';
  if (!merged) return vote ? `Rejected by vote on ${date}: ${tally}.` : `Rejected on ${date}.`;
  if (cr.approvedAs?.voted && vote) return `Merged on ${date} after a vote: ${tally}.`;
  // Older server records fall back to live evaluation; older device copies may have neither field.
  const signoffs = cr.approvedAs?.approvers?.map((a) => a.name ?? who(a.userId)) ?? (cr.governance.approvedBy ?? []).map(who);
  const signedBy = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(signoffs);
  return `Merged on ${date}${signoffs.length ? ` after sign-off from ${signedBy}` : ''}.`;
}
