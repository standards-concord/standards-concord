import { useId } from 'react';
import type { ChangeLevel, ChangeRequestOrigin, ChangeRequestStatus, OntologySummary, Role, UseCaseSource, CompetencyQuestion } from '@concord/shared';
import { Bot, Bug, CircleCheck, CircleAlert, Combine, FileText, GitFork, GitMerge, Globe, IdCard, MessageSquareText, Pencil, Users, type LucideIcon } from 'lucide-react';
import { Badge, cx } from './ui';
import { pct, roleLabel } from '../lib/format';

export function LevelBadge({ level, className }: { level?: ChangeLevel; className?: string }) {
  if (!level) return null;
  const cls = {
    patch: 'bg-surface-2 text-muted border border-line-strong',
    minor: 'bg-accent-soft text-accent border border-accent/30',
    major: 'bg-warn-soft text-warn border border-warn/40',
  }[level];
  return (
    <span className={cx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[0.7rem] font-semibold', cls, className)} title={`${level} change (semver)`}>
      {level[0].toUpperCase() + level.slice(1)}
    </span>
  );
}

export const CR_STATUS_LABEL: Record<ChangeRequestStatus, string> = {
  draft: 'Draft',
  triage: 'Triage',
  review: 'In review',
  voting: 'Voting',
  approved: 'Approved',
  merged: 'Merged',
  released: 'Released',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  'needs-work': 'Needs work',
};

export function StatusPill({ status }: { status: ChangeRequestStatus }) {
  const tone = (
    {
      draft: 'outline',
      triage: 'neutral',
      review: 'accent',
      voting: 'accent',
      approved: 'ok',
      merged: 'ok',
      released: 'ok',
      rejected: 'danger',
      withdrawn: 'neutral',
      'needs-work': 'warn',
    } as const
  )[status];
  return <Badge tone={tone}>{CR_STATUS_LABEL[status] ?? status}</Badge>;
}

export function originInfo(origin?: ChangeRequestOrigin): { icon: LucideIcon; label: string } {
  switch (origin?.type) {
    case 'chat':
      return { icon: MessageSquareText, label: 'From an interview' };
    case 'meeting':
      return { icon: Users, label: 'From a meeting' };
    case 'agent':
      return { icon: Bot, label: origin.agentName ? `From agent ${origin.agentName}` : 'From a coding agent' };
    case 'bug-report':
      return { icon: Bug, label: 'Bug report' };
    case 'public-report':
      return { icon: Globe, label: 'Reported from the public page' };
    case 'synthesis':
      return { icon: Combine, label: 'Synthesised from use cases' };
    case 'fork':
      return { icon: GitFork, label: `From the fork ${origin.forkSlug}` };
    default:
      return { icon: Pencil, label: 'Proposed directly' };
  }
}

export function OriginIcon({ origin, withLabel }: { origin?: ChangeRequestOrigin; withLabel?: boolean }) {
  const { icon: Icon, label } = originInfo(origin);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted" title={label}>
      <Icon className="size-3.5" />
      {withLabel && label}
    </span>
  );
}

export function RoleChips({ roles, className }: { roles: Role[]; className?: string }) {
  return (
    <span className={cx('inline-flex flex-wrap gap-1', className)}>
      {roles.map((r) => (
        <Badge key={r} tone={r === 'owner' || r === 'steward' ? 'accent' : r === 'odi' ? 'warn' : 'neutral'}>
          {roleLabel(r)}
        </Badge>
      ))}
    </span>
  );
}

export function SourceBadge({ source }: { source: UseCaseSource }) {
  const m: Record<UseCaseSource, { icon: LucideIcon; label: string }> = {
    chat: { icon: MessageSquareText, label: 'Interview' },
    meeting: { icon: Users, label: 'Meeting' },
    agent: { icon: Bot, label: 'Agent' },
    form: { icon: FileText, label: 'Form' },
  };
  const { icon, label } = m[source] ?? m.form;
  return (
    <Badge tone="outline" icon={icon}>
      {label}
    </Badge>
  );
}

export function CqStatusChip({ status }: { status: CompetencyQuestion['status'] }) {
  const m = {
    answerable: { tone: 'ok' as const, label: 'Answerable' },
    unanswerable: { tone: 'danger' as const, label: 'Unanswerable' },
    untested: { tone: 'neutral' as const, label: 'Untested' },
    draft: { tone: 'outline' as const, label: 'Draft' },
  }[status] ?? { tone: 'neutral' as const, label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function GoogleIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}

export function GitHubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

/**
 * The Open Data Institute logo (the solid O, D and I), drawn in the current text colour, so
 * it is black on white and white on black as the ODI brand asks. Used by the ODI look only.
 */
export function OdiLogo({ className }: { className?: string }) {
  return (
    <svg className={cx('h-6 w-auto', className)} viewBox="0 0 200 85.8" fill="currentColor" role="img" aria-label="Open Data Institute">
      <path d="M160,.7V27.2A37.9,37.9,0,0,0,136.6,3.7,49.7,49.7,0,0,0,119.1.6H82.7V27a42.9,42.9,0,1,0,0,31.8V85.1h36.4a51.9,51.9,0,0,0,17.5-3,41.9,41.9,0,0,0,13.8-8.5A40.1,40.1,0,0,0,160,58.5V85.1h40V.7Z" />
    </svg>
  );
}

/**
 * The Solid project's emblem, from solidproject.org, for signing in with Solid.
 * Unaltered (white edge, Solid purple), so it reads on any background.
 */
export function SolidIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={cx('shrink-0', className)} viewBox="0 0 352 322" aria-hidden data-logo="solid">
      <path
        fill="#FFF"
        d="M87.97296 282.3527 27.24133 177.02207c-5.62041-9.75765-5.62041-21.77908 0-31.53674L87.97296 40.2328c5.64643-9.78367 16.08061-15.79439 27.32143-15.79439h121.3852c11.26684 0 21.72704 6.01072 27.32143 15.7944l60.75765 105.30458c5.62041 9.75766 5.62041 21.77909 0 31.53674l-60.73163 105.33061c-5.64643 9.78367-16.08061 15.79439-27.32143 15.79439H115.37245c-11.31888-.05204-21.72704-6.08878-27.3995-15.84643z"
      />
      <path
        fill="#7C4DFF"
        d="M93.15102 275.19708 36.03622 176.13738c-5.30816-9.1852-5.30816-20.50408 0-29.66326l57.1148-99.08572c5.33418-9.21122 15.14388-14.85765 25.73418-14.85765h114.2296c10.5903 0 20.42602 5.64643 25.73418 14.85765l57.16684 99.03368c5.30816 9.1852 5.30816 20.50408 0 29.66326L258.875 275.2231c-5.33418 9.21122-15.14388 14.85765-25.73418 14.85765H118.93724c-10.64234 0-20.45204-5.67245-25.78622-14.88367z"
      />
      <path
        fill="#F7F7F7"
        d="M118.46888 142.2328h117.53418c1.48316 0 2.65408-1.19695 2.65408-2.65409v-22.03928c0-14.6495-11.89132-26.54085-26.54081-26.54085h-70.56735c-20.5301-.026-37.15722 16.60105-37.15722 37.13115-.02594 7.83214 6.271 14.10306 14.07712 14.10306zM129.99592 239.60116H200.225c21.20663 0 38.43214-17.22551 38.43214-38.43214 0-7.07755-5.72449-12.82806-12.82806-12.82806H106.94184c-1.45715 0-2.55005 1.17091-2.55005 2.55v23.05408c-.02597 14.18112 11.47505 25.65612 25.60413 25.65612z"
      />
      <path
        fill="#F7F7F7"
        d="m109.59592 139.3185 87.66275 87.66276c5.80255 5.80255 15.19592 5.80255 20.99847 0l15.19592-15.19592c5.80255-5.80255 5.80255-15.19591 0-20.99847l-87.63673-87.66275c-5.80255-5.80255-15.19592-5.80255-20.99847 0l-15.19592 15.19592c-5.8546 5.80255-5.8546 15.22194-.02602 20.99847z"
      />
      <path fill="#444" opacity=".3" d="m198.6898 228.46443-51.4944-40.12347h11.39695zM144.35918 101.66698l40.56582 40.56581h13.7648z" />
    </svg>
  );
}

/** For a WebID itself (not the sign-in option). A generic ID-card mark, not any project's logo. */
export function WebIdIcon({ className = 'size-4' }: { className?: string }) {
  return <IdCard className={className} aria-hidden />;
}

/**
 * Concord's mark: the top view of a delta-winged supersonic airliner (a nod to Concorde, whose
 * name it shares), split down the middle into two halves that meet, as parties do in concord.
 * It climbs at 45° with a slipstream behind it. Drawn nose-up on a 64-unit grid; index.html's
 * favicon uses the same plane without the slipstream, which turns to noise at 16px.
 */
export const LOGO_LEFT =
  'M31 5.5C30.3 8.5 29.7 12 29.6 16L29.4 21C28.8 31 25.5 38 18 45C14 48.6 10.6 50.5 8 52.6L8 55.2L29 55.6L29.8 59L31 60.2Z';
export const LOGO_RIGHT =
  'M33 5.5C33.7 8.5 34.3 12 34.4 16L34.6 21C35.2 31 38.5 38 46 45C50 48.6 53.4 50.5 56 52.6L56 55.2L35 55.6L34.2 59L33 60.2Z';
/** Streaks trailing behind the wing, longest behind the tail; the tile clips their ends. */
const LOGO_SLIPSTREAM = 'M13 52V66M22 57V78M32 62V92M42 57V78M51 52V66';

export function Logo({ className }: { className?: string }) {
  const clip = `concord-logo-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg className={cx('size-7', className)} viewBox="0 0 64 64" aria-hidden data-logo="concord">
      <defs>
        <clipPath id={clip}>
          <rect className="app-logo-bg" width="64" height="64" rx="16" />
        </clipPath>
      </defs>
      <rect className="app-logo-bg" width="64" height="64" rx="16" fill="var(--accent)" />
      <g clipPath={`url(#${clip})`}>
        <g transform="rotate(45 32 32)">
          <path d={LOGO_SLIPSTREAM} fill="none" stroke="var(--accent-fg)" strokeWidth="2.4" strokeLinecap="round" strokeOpacity=".5" />
          <g transform="translate(32 25) scale(.9) translate(-32 -32)">
            {/* A halo in the tile colour, so the slipstream stops short of the plane. */}
            <g fill="var(--accent)" stroke="var(--accent)" strokeWidth="5" strokeLinejoin="round">
              <path d={LOGO_LEFT} />
              <path d={LOGO_RIGHT} />
            </g>
            <g fill="var(--accent-fg)">
              <path d={LOGO_LEFT} />
              <path d={LOGO_RIGHT} fillOpacity=".62" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
