import type { Vote } from '@concord/shared';

/**
 * How a change request vote stands, for its badge. A vote on earlier edits no longer counts, except
 * a person's own "no", which stands until they change it. Autopilot's votes never carry over to new
 * edits (it votes again on them), so an earlier autopilot "no" is shown as no longer counting.
 */
export function voteStanding(v: Pick<Vote, 'stale' | 'editsVersion' | 'autopilot'>, editsVersion: number | undefined): 'current' | 'earlier' | 'earlier-still-counts' {
  if (v.stale) return 'earlier';
  if ((v.editsVersion ?? 1) === (editsVersion ?? 1)) return 'current';
  return v.autopilot ? 'earlier' : 'earlier-still-counts';
}
