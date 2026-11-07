import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Clapperboard, Compass, FileText, ListVideo, MessageSquareHeart, SkipForward } from 'lucide-react';
import { api, type ClipManifest, type MediaIndex } from '../api';
import { useAsync } from '../lib/hooks';
import { Button, Card, cx, Select } from '../components/ui';

/**
 * The page to send alpha testers to: what Concord is and what it's for, two short
 * videos (a tour, and how to take part), a playlist of short clips of one feature each,
 * then into the guided walkthrough. It works without signing in and without the videos
 * (they appear once a release has them).
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

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
/** Where a clip is, for links: /welcome#clip-validate. */
const clipHash = (id: string) => `#clip-${id}`;

/**
 * A playlist of short clips, one feature each: pick one from the list, and the next one
 * plays when it ends. Only clips whose video the release really has are listed.
 */
function FeatureClips({ index, loading }: { index?: MediaIndex; loading: boolean }) {
  const has = (name: string) => index?.files.find((f) => f.name === name)?.url;
  const manifestUrl = has('concord-clips.json');
  const [manifest, setManifest] = useState<ClipManifest | null>();
  useEffect(() => {
    if (!manifestUrl) {
      setManifest(loading ? undefined : null);
      return;
    }
    let live = true;
    api.mediaClips().then(
      (m) => live && setManifest(m),
      () => live && setManifest(null),
    );
    return () => {
      live = false;
    };
  }, [manifestUrl, loading]);
  const clips = useMemo(
    () => (manifest?.clips ?? []).filter((c) => /^concord-clip-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.file) && typeof c.title === 'string' && index?.files.some((f) => f.name === `${c.file}.mp4`)),
    [manifest, index],
  );
  const [autoplay, setAutoplay] = useState(false);
  // Clip ids are plain lowercase words, so anything else in the hash is ignored.
  const fromHash = () => /^#clip-([a-z0-9-]+)$/.exec(location.hash)?.[1] ?? '';
  const [picked, setPicked] = useState(fromHash);
  const linked = useRef(picked);
  // Following a link to another clip on this page changes only the hash.
  useEffect(() => {
    const on = () => {
      const id = fromHash();
      if (!id) return;
      setPicked(id);
      setAutoplay(false);
      linked.current = id;
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const section = useRef<HTMLElement>(null);
  const current = clips.find((c) => c.id === picked) ?? clips[0];
  const next = current && clips[clips.indexOf(current) + 1];
  // A link to one clip (/welcome#clip-vote) scrolls to the playlist once it has loaded.
  useEffect(() => {
    if (linked.current && current?.id === linked.current) {
      section.current?.scrollIntoView({ block: 'start' });
      linked.current = '';
    }
  }, [current]);
  const choose = (id: string, play: boolean) => {
    setPicked(id);
    setAutoplay(play);
    history.replaceState(null, '', clipHash(id));
  };

  return (
    <section ref={section} id="clips" aria-labelledby="clips-title" className="mt-14 scroll-mt-20">
      <h2 id="clips-title" className="text-xl font-semibold tracking-tight">
        More features
      </h2>
      {current ? (
        <Card as="article" className="mt-6 overflow-hidden md:grid md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="aspect-video bg-black">
            <video
              key={current.file}
              className="size-full bg-black"
              controls
              autoPlay={autoplay}
              preload="metadata"
              playsInline
              aria-labelledby="clip-title"
              onEnded={() => next && choose(next.id, true)}
              data-testid="clip-video"
            >
              <source src={has(`${current.file}.mp4`)} type="video/mp4" />
              {has(`${current.file}.vtt`) && <track kind="captions" srcLang="en" label="English" src={has(`${current.file}.vtt`)} default />}
            </video>
          </div>
          <div className="flex flex-col gap-3 p-5">
            <label className="text-sm font-medium" htmlFor="clip-picker">
              <ListVideo className="mr-1.5 inline size-4 align-[-3px] text-accent" aria-hidden />
              Choose a feature
            </label>
            <Select id="clip-picker" value={current.id} onChange={(e) => choose(e.target.value, false)}>
              {clips.map((c, i) => (
                <option key={c.id} value={c.id}>
                  {i + 1}. {c.title}
                  {c.duration ? ` (${clock(c.duration)})` : ''}
                </option>
              ))}
            </Select>
            <h3 id="clip-title" className="mt-1 font-semibold">
              {current.title}
            </h3>
            {current.summary && <p className="text-sm text-muted">{current.summary}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {has(`${current.file}.transcript.md`) && (
                <a href={has(`${current.file}.transcript.md`)} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                  <FileText className="size-3.5" aria-hidden /> Read the transcript
                </a>
              )}
              {next && (
                <Button size="sm" variant="ghost" icon={SkipForward} onClick={() => choose(next.id, true)}>
                  Next: {next.title}
                </Button>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="mt-6">
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted" data-testid="clips-pending">
            <Clapperboard className="size-6 text-subtle" aria-hidden />
            {loading || manifest === undefined ? 'Checking for the clips…' : 'Short clips of single features are being recorded for the next release.'}
          </div>
        </Card>
      )}
    </section>
  );
}

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
        <p className="mt-4 text-sm text-muted" data-testid="welcome-confidential">
          Everything happens in a shared demo that other testers can see, so please don’t enter anything confidential. No account is needed: you’ll play one of the demo
          participants.
        </p>
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
      </section>

      <section aria-labelledby="videos-title" className="mt-14">
        <h2 id="videos-title" className="text-xl font-semibold tracking-tight">
          Watch first, if you like
        </h2>
        <p className="mt-2 max-w-2xl text-muted">Optional: the guided walkthrough covers the same ground.</p>
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

      <FeatureClips index={media.data} loading={media.loading} />
    </div>
  );
}
