import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Clapperboard, Compass, FileText, MessageSquareHeart, Scale, ShieldCheck, Users } from 'lucide-react';
import { api, type MediaIndex } from '../api';
import { useAsync } from '../lib/hooks';
import { Card, cx } from '../components/ui';

/**
 * The page to send alpha testers to: what Concord is and what it's for, two short
 * videos (a tour, and how to take part), then into the guided walkthrough. It works
 * without signing in and without the videos (they appear once a release has them).
 */

function LinkButton({ to, primary, icon: Icon, children }: { to: string; primary?: boolean; icon?: typeof ArrowRight; children: ReactNode }) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-5 text-sm font-medium whitespace-nowrap transition-colors',
        primary ? 'border-transparent bg-accent text-accent-fg shadow-sm hover:bg-accent-hover' : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
      )}
    >
      {Icon && <Icon className="size-4" aria-hidden />}
      {children}
    </Link>
  );
}

const minutes = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} seconds` : `${Math.round(s / 60)} minutes`);

function Video({ id, title, blurb, base, index, loading }: { id: string; title: string; blurb: string; base: string; index?: MediaIndex; loading: boolean }) {
  const [length, setLength] = useState<number>();
  const has = (ext: string) => index?.files.find((f) => f.name === `${base}.${ext}`)?.url;
  const mp4 = has('mp4');
  const vtt = has('vtt');
  const transcript = has('transcript.md');
  return (
    <Card as="article" className="flex flex-col overflow-hidden">
      <div className="aspect-video bg-surface-2">
        {mp4 ? (
          <video
            className="size-full bg-black"
            controls
            preload="metadata"
            playsInline
            aria-labelledby={`${id}-title`}
            onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
            data-testid={`${id}-video`}
          >
            <source src={mp4} type="video/mp4" />
            {vtt && <track kind="captions" srcLang="en" label="English" src={vtt} default />}
          </video>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted" data-testid={`${id}-pending`}>
            <Clapperboard className="size-6 text-subtle" aria-hidden />
            {loading ? 'Checking for the video…' : 'This video is being recorded for the next release. The guided walkthrough covers the same ground in the meantime.'}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 id={`${id}-title`} className="font-semibold">
          {title}
        </h3>
        {length ? <p className="text-xs text-muted">{minutes(length)}, with captions</p> : null}
        <p className="mt-2 text-sm text-muted">{blurb}</p>
        {transcript && (
          <a href={transcript} className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
            <FileText className="size-3.5" aria-hidden /> Read the transcript
          </a>
        )}
      </div>
    </Card>
  );
}

const AIMS: { icon: typeof ShieldCheck; title: string; text: string }[] = [
  {
    icon: ShieldCheck,
    title: 'Rigorous by default',
    text: 'Standards are written in strict OWL. A reasoner keeps them logically consistent, and every change is checked against FAIR principles and the questions the standard has to answer.',
  },
  {
    icon: Users,
    title: 'Shaped by the people who use them',
    text: 'Requirements come from use cases, AI-led interviews, meeting transcripts, and coding agents that report concepts a standard is missing.',
  },
  {
    icon: Scale,
    title: 'Governance without endless meetings',
    text: 'Each change is classified as a fix, a minor or a major change, then reviewed, signed off or voted on under rules the community sets for itself.',
  },
];

const STEPS: [string, string][] = [
  ['Pick a role', 'A steward, a domain expert, a voting member, ODI oversight or an agent developer. You can switch at any time.'],
  ['Try the tasks for that role', 'A short checklist points you at the parts of Concord that matter to that role.'],
  ['Let the others act', 'The other participants are simulated. Make them comment, review and vote, and fast-forward time to close reviews.'],
  ['Tell us what you think', 'Type or just talk. Take the guided questions (about 8 minutes) or leave a quick note.'],
];

export function WelcomePage() {
  const media = useAsync(() => api.mediaIndex(), []);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 md:py-16">
      <section aria-labelledby="welcome-title" className="max-w-2xl">
        <div className="page-eyebrow mb-3 text-xs font-medium tracking-wide text-muted uppercase">Alpha testing</div>
        <h1 id="welcome-title" className="page-title">
          Help us test Concord
        </h1>
        <p className="mt-4 text-lg text-muted">
          Concord is an early prototype for designing open data standards together. We’d love you to try it for about twenty minutes and tell us honestly what works and what
          doesn’t.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <LinkButton to="/alpha" primary icon={Compass}>
            Start the guided walkthrough
          </LinkButton>
          <LinkButton to="/feedback" icon={MessageSquareHeart}>
            Just leave feedback
          </LinkButton>
        </div>
      </section>

      {/* Filled in by the returning-tester work: version, sign-in prompt, what's changed. */}
      <section id="welcome-status" aria-label="Your progress" className="mt-8 empty:hidden" />

      <section aria-labelledby="what-title" className="mt-14">
        <h2 id="what-title" className="text-xl font-semibold tracking-tight">
          What Concord is for
        </h2>
        <p className="mt-2 max-w-2xl text-muted">
          Data standards, such as a shared vocabulary for volunteering opportunities, are usually agreed in long meetings and edited by a few experts. Concord lets the whole
          community shape a standard, keeps it rigorous, and runs its decisions in the open.
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {AIMS.map(({ icon: Icon, title, text }) => (
            <Card key={title} className="p-5">
              <Icon className="size-5 text-accent" aria-hidden />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm text-muted">{text}</p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="videos-title" className="mt-14">
        <h2 id="videos-title" className="text-xl font-semibold tracking-tight">
          Watch first, if you like
        </h2>
        <p className="mt-2 max-w-2xl text-muted">
          Two short narrated videos. They’re optional: the guided walkthrough explains everything as you go.
          {media.data?.release ? <> Recorded for release {media.data.release.tag}.</> : null}
        </p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Video
            id="tour"
            base="concord-walkthrough"
            title="A tour of Concord"
            blurb="What Concord is for, how a standard grows from requirements into a published release, and how developers build on it."
            index={media.data}
            loading={media.loading}
          />
          <Video
            id="feedback"
            base="concord-feedback"
            title="How to take part and give feedback"
            blurb="How the guided walkthrough works, how to play a role alongside simulated participants, and how to tell us what you think."
            index={media.data}
            loading={media.loading}
          />
        </div>
      </section>

      <section aria-labelledby="how-title" className="mt-14">
        <h2 id="how-title" className="text-xl font-semibold tracking-tight">
          How the alpha works
        </h2>
        <ol className="mt-4 max-w-2xl divide-y divide-line border-y border-line text-sm">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex gap-4 py-3">
              <span className="font-mono text-xs text-subtle tabular-nums">{String(i + 1).padStart(2, '0')}</span>
              <span>
                <span className="font-medium">{t}.</span> <span className="text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 max-w-2xl text-sm text-muted">
          Everything happens in a shared demo that other testers can see, so please don’t enter anything confidential. No account is needed: you’ll play one of the demo
          participants.
        </p>
      </section>

      <section aria-labelledby="start-title" className="mt-14 rounded-xl border border-line bg-surface-2 p-6 sm:p-8">
        <h2 id="start-title" className="text-xl font-semibold tracking-tight">
          Ready?
        </h2>
        <p className="mt-2 max-w-xl text-muted">The guided walkthrough takes you through it step by step, and saves your place in this browser.</p>
        <div className="mt-5">
          <LinkButton to="/alpha" primary icon={ArrowRight}>
            Start the guided walkthrough
          </LinkButton>
        </div>
      </section>
    </div>
  );
}
