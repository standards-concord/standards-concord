import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { SessionProvider, useSession } from './lib/session';
import { OntologiesProvider } from './lib/ontologies';
import { WalkthroughProvider } from './lib/walkthrough';
import { Page, Shell } from './components/Shell';
import { Button, ErrorCard, Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { HubPage } from './pages/Hub';
import { FederationPage, FederationsPage } from './pages/Federations';
import { AlphaPage } from './pages/Alpha';
import { FeedbackPage } from './pages/Feedback';
import { WelcomePage } from './pages/Welcome';
import { SettingsPage } from './pages/Settings';
import { AppearancePage } from './pages/Appearance';
import { NotFound } from './pages/NotFound';
import { PrivacyPage } from './pages/Privacy';
import { OntologyLayout } from './pages/ontology/Layout';
import { OverviewTab } from './pages/ontology/Overview';
import { BrowseTab } from './pages/ontology/Browse';
import { SourceTab } from './pages/ontology/Source';
import { QueryTab } from './pages/ontology/Query';
import { ValidateTab } from './pages/ontology/Validate';
import { UseCasesTab } from './pages/ontology/UseCases';
import { UseCaseDetailPage } from './pages/ontology/UseCaseDetail';
import { InterviewPage } from './pages/ontology/Interview';
import { MeetingsTab } from './pages/ontology/Meetings';
import { MeetingDetailPage } from './pages/ontology/MeetingDetail';
import { ChangeRequestsTab } from './pages/ontology/ChangeRequests';
import { ChangeRequestPage } from './pages/ontology/ChangeRequestDetail';
import { ForksTab } from './pages/ontology/Forks';
import { ForkPage } from './pages/ontology/ForkDetail';
import { ReleasesTab } from './pages/ontology/Releases';
import { ReleaseDetailPage } from './pages/ontology/ReleaseDetail';
import { RequirementsDocPage } from './pages/ontology/RequirementsDoc';
import { GovernanceTab } from './pages/ontology/Governance';
import { AgentReportsTab, ConnectAgentTab } from './pages/ontology/Agents';
import { ConnectPage } from './pages/Connect';
import { OAuthAuthorizePage } from './pages/OAuthAuthorize';
import { AppsTab } from './pages/ontology/Apps';

const AdminFeedbackPage = lazy(() => import('./pages/AdminFeedback').then((m) => ({ default: m.AdminFeedbackPage })));

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
  if (!session && loading) return <Loading label="Connecting…" className="py-24" />;
  if (!session)
    return (
      <Page>
        <ErrorCard error={error} onRetry={() => void refresh()} />
        <p className="mt-4 text-sm text-muted">Concord needs its API server to be running. If you’re developing locally, start it with <code className="font-mono">pnpm --filter @concord/server dev</code>.</p>
      </Page>
    );
  if (!session.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
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
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
      </Suspense>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <SessionProvider>
      <OntologiesProvider>
        <WalkthroughProvider>
          <Shell>
            <Routed />
          </Shell>
        </WalkthroughProvider>
      </OntologiesProvider>
    </SessionProvider>
  );
}
