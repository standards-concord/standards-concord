import { Component, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { SessionProvider, useSession } from './lib/session';
import { OntologiesProvider } from './lib/ontologies';
import { WalkthroughProvider } from './lib/walkthrough';
import { Page, Shell } from './components/Shell';
import { Button, ErrorCard, Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { HubPage } from './pages/Hub';
import { NotFound } from './pages/NotFound';
import { RouteBoundary } from './components/RouteBoundary';
import { PagePending } from './components/PagePending';
import { lazyPage } from './lib/routeChunks';

const JoinPage = lazyPage('join', () => import('./pages/Join').then((m) => ({ default: m.JoinPage })));
const FederationPage = lazyPage('federation-detail', () => import('./pages/Federations').then((m) => ({ default: m.FederationPage })));
const FederationsPage = lazyPage('federations', () => import('./pages/Federations').then((m) => ({ default: m.FederationsPage })));
const AlphaPage = lazyPage('alpha', () => import('./pages/Alpha').then((m) => ({ default: m.AlphaPage })));
const FeedbackPage = lazyPage('feedback', () => import('./pages/Feedback').then((m) => ({ default: m.FeedbackPage })));
const WelcomePage = lazyPage('welcome', () => import('./pages/Welcome').then((m) => ({ default: m.WelcomePage })));
const SettingsPage = lazyPage('settings', () => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const AppearancePage = lazyPage('appearance', () => import('./pages/Appearance').then((m) => ({ default: m.AppearancePage })));
const PrivacyPage = lazyPage('privacy', () => import('./pages/Privacy').then((m) => ({ default: m.PrivacyPage })));
const OntologyLayout = lazyPage('layout', () => import('./pages/ontology/Layout').then((m) => ({ default: m.OntologyLayout })));
const OverviewTab = lazyPage('overview', () => import('./pages/ontology/Overview').then((m) => ({ default: m.OverviewTab })));
const BrowseTab = lazyPage('browse', () => import('./pages/ontology/Browse').then((m) => ({ default: m.BrowseTab })));
const SourceTab = lazyPage('source', () => import('./pages/ontology/Source').then((m) => ({ default: m.SourceTab })));
const QueryTab = lazyPage('query', () => import('./pages/ontology/Query').then((m) => ({ default: m.QueryTab })));
const ValidateTab = lazyPage('validate', () => import('./pages/ontology/Validate').then((m) => ({ default: m.ValidateTab })));
const UseCasesTab = lazyPage('use-cases', () => import('./pages/ontology/UseCases').then((m) => ({ default: m.UseCasesTab })));
const UseCaseDetailPage = lazyPage('usecasedetail', () => import('./pages/ontology/UseCaseDetail').then((m) => ({ default: m.UseCaseDetailPage })));
const InterviewPage = lazyPage('interview', () => import('./pages/ontology/Interview').then((m) => ({ default: m.InterviewPage })));
const MeetingsTab = lazyPage('meetings', () => import('./pages/ontology/Meetings').then((m) => ({ default: m.MeetingsTab })));
const MeetingDetailPage = lazyPage('meetingdetail', () => import('./pages/ontology/MeetingDetail').then((m) => ({ default: m.MeetingDetailPage })));
const ChangeRequestsTab = lazyPage('changes', () => import('./pages/ontology/ChangeRequests').then((m) => ({ default: m.ChangeRequestsTab })));
const ChangeRequestPage = lazyPage('changerequestdetail', () => import('./pages/ontology/ChangeRequestDetail').then((m) => ({ default: m.ChangeRequestPage })));
const ForksTab = lazyPage('forks', () => import('./pages/ontology/Forks').then((m) => ({ default: m.ForksTab })));
const ForkPage = lazyPage('forkdetail', () => import('./pages/ontology/ForkDetail').then((m) => ({ default: m.ForkPage })));
const ReleasesTab = lazyPage('releases', () => import('./pages/ontology/Releases').then((m) => ({ default: m.ReleasesTab })));
const ReleaseDetailPage = lazyPage('releasedetail', () => import('./pages/ontology/ReleaseDetail').then((m) => ({ default: m.ReleaseDetailPage })));
const RequirementsDocPage = lazyPage('requirementsdoc', () => import('./pages/ontology/RequirementsDoc').then((m) => ({ default: m.RequirementsDocPage })));
const GovernanceTab = lazyPage('governance', () => import('./pages/ontology/Governance').then((m) => ({ default: m.GovernanceTab })));
const AgentReportsTab = lazyPage('agents', () => import('./pages/ontology/Agents').then((m) => ({ default: m.AgentReportsTab })));
const ConnectAgentTab = lazyPage('connect', () => import('./pages/ontology/ConnectAgent').then((m) => ({ default: m.ConnectAgentTab })));
const ConnectPage = lazyPage('account-connect', () => import('./pages/Connect').then((m) => ({ default: m.ConnectPage })));
const OAuthAuthorizePage = lazyPage('oauthauthorize', () => import('./pages/OAuthAuthorize').then((m) => ({ default: m.OAuthAuthorizePage })));
const AppsTab = lazyPage('apps', () => import('./pages/ontology/Apps').then((m) => ({ default: m.AppsTab })));
const AdminFeedbackPage = lazyPage('admin-feedback', () => import('./pages/AdminFeedback').then((m) => ({ default: m.AdminFeedbackPage })));

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }
  render() {
    if (this.state.error)
      return (
        <Page>
          <ErrorCard title="This page crashed" error={this.state.error} />
          <div className="mt-4">
            <Button onClick={() => this.setState({ error: undefined })}>Try again</Button>
          </div>
        </Page>
      );
    return this.props.children;
  }
}

/** Gate for pages that need a signed-in user. */
function RequireUser({ children }: { children: ReactNode }) {
  const { session, loading, error, refresh } = useSession();
  const loc = useLocation();
  const navigate = useNavigate();
  const signedOut = !!session && !session.user;
  useEffect(() => {
    if (!signedOut) return;
    const here = loc.pathname + loc.search + loc.hash;
    const toLogin = () => navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
    // Signing out moves to sign-in itself, and the address changes before the router shows it. Redirecting then
    // as well would send the next person to sign in here to the page the last one had open.
    if (window.location.pathname + window.location.search + window.location.hash === here) toLogin();
    // Going back just as that redirect is made can land on this same page before the router has shown /login. The
    // router then sees no change at all, so nothing renders or redirects again, and the page stays blank (#100). So
    // while this page is up, a move back to it redirects again. (A move anywhere else renders that page instead.)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPop = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (window.location.pathname + window.location.search + window.location.hash === here) toLogin();
      });
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      clearTimeout(timer);
    };
  }, [signedOut, loc, navigate]);
  if (!session && loading) return <Loading label="Connecting…" className="py-24" />;
  if (!session)
    return (
      <Page>
        <ErrorCard error={error} onRetry={() => void refresh()} />
        <p className="mt-4 text-sm text-muted">Concord needs its API server to be running. If you’re developing locally, start it with <code className="font-mono">pnpm --filter @concord/server dev</code>.</p>
      </Page>
    );
  if (!session.user) return null;
  return <>{children}</>;
}

/** Agents, tokens and appearance used to live in Settings. Old links go straight to their public pages, signed in or not. */
const MOVED_FROM_SETTINGS: Record<string, string> = { '#agents': '/connect#agents', '#tokens': '/connect#tokens', '#appearance': '/appearance' };
function SettingsRoute() {
  const { hash } = useLocation();
  const moved = MOVED_FROM_SETTINGS[hash];
  if (moved) return <Navigate to={moved} replace />;
  return (
    <RequireUser>
      <SettingsPage />
    </RequireUser>
  );
}

function Routed() {
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <RouteBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/join/:secret" element={<JoinPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/alpha" element={<AlphaPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/appearance" element={<AppearancePage />} />
          <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
          <Route path="/" element={<RequireUser><HubPage /></RequireUser>} />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="/f" element={<RequireUser><FederationsPage /></RequireUser>} />
          <Route path="/f/:slug" element={<RequireUser><FederationPage /></RequireUser>} />
          <Route path="/admin/feedback" element={<RequireUser><AdminFeedbackPage /></RequireUser>} />
          <Route path="/o/:id" element={<RequireUser><OntologyLayout /></RequireUser>}>
            <Route index element={<OverviewTab />} />
            <Route path="browse" element={<BrowseTab />} />
            <Route path="source" element={<SourceTab />} />
            <Route path="query" element={<QueryTab />} />
            <Route path="validate" element={<ValidateTab />} />
            <Route path="use-cases" element={<UseCasesTab />} />
            <Route path="use-cases/:useCaseId" element={<UseCaseDetailPage />} />
            <Route path="interview/:sessionId" element={<InterviewPage />} />
            <Route path="meetings" element={<MeetingsTab />} />
            <Route path="meetings/:meetingId" element={<MeetingDetailPage />} />
            <Route path="changes" element={<ChangeRequestsTab />} />
            <Route path="changes/:crId" element={<ChangeRequestPage />} />
            <Route path="forks" element={<ForksTab />} />
            <Route path="forks/:forkSlug" element={<ForkPage />} />
            <Route path="releases" element={<ReleasesTab />} />
            <Route path="releases/:releaseId" element={<ReleaseDetailPage />} />
            <Route path="requirements/:version" element={<RequirementsDocPage />} />
            <Route path="governance" element={<GovernanceTab />} />
            <Route path="agents" element={<AgentReportsTab />} />
            <Route path="connect" element={<ConnectAgentTab />} />
            <Route path="apps" element={<AppsTab />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </RouteBoundary>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <SessionProvider>
      <OntologiesProvider>
        <WalkthroughProvider>
          <PagePending />
          <Shell>
            <Routed />
          </Shell>
        </WalkthroughProvider>
      </OntologiesProvider>
    </SessionProvider>
  );
}
