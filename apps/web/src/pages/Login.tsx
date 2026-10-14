import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Compass, KeyRound, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { GitHubIcon, GoogleIcon, Logo } from '../components/badges';
import { Button, Card, ErrorCard, InlineError, Loading } from '../components/ui';

export function LoginPage() {
  const { session, loading, error, refresh, setSession } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const next = params.get('next') || '/';
  const demo = useAction(async () => {
    const s = await api.demoLogin({});
    setSession(s);
    nav(next === '/' ? '/alpha' : next);
  });

  if (session?.user) return <Navigate to={next} replace />;

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16">
      <div className="mb-8 text-center">
        <Logo className="mx-auto size-11" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to Concord</h1>
        <p className="mt-2 text-sm text-muted">Design strict OWL ontologies together, with AI help, and run their governance without needing meetings.</p>
      </div>

      {!session && loading ? (
        <Loading label="Connecting…" />
      ) : !session ? (
        <ErrorCard error={error} onRetry={() => void refresh()} />
      ) : (
        <Card className="p-6">
          <div className="space-y-3">
            {session.providers.google && (
              <a href={api.oauthUrl('google', next)} className="block">
                <Button size="lg" className="w-full">
                  <GoogleIcon /> Sign in with Google
                </Button>
              </a>
            )}
            {session.providers.github && (
              <a href={api.oauthUrl('github', next)} className="block">
                <Button size="lg" className="w-full">
                  <GitHubIcon /> Sign in with GitHub
                </Button>
              </a>
            )}
            {(session.providers.google || session.providers.github) && session.providers.demo && (
              <div className="flex items-center gap-3 py-1 text-xs text-subtle">
                <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
              </div>
            )}
            {session.providers.demo && (
              <Button size="lg" variant="primary" className="w-full" icon={Sparkles} loading={demo.pending} onClick={() => void demo.run()}>
                Try the demo
              </Button>
            )}
            {!session.providers.google && !session.providers.github && !session.providers.demo && (
              <p className="text-sm text-muted">No sign-in methods are configured on this server.</p>
            )}
            <InlineError error={demo.error} />
          </div>
          <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            We create a WebID and a private Solid pod for you automatically — your interview transcripts are stored there, not in a shared database.
          </p>
        </Card>
      )}

      <button onClick={() => nav('/alpha')} className="mx-auto mt-6 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
        <Compass className="size-4" /> Alpha tester? Start the guided walkthrough
      </button>
    </div>
  );
}
