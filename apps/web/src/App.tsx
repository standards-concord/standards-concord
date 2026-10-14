import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { SessionProvider, useSession } from './lib/session';
import { OntologiesProvider } from './lib/ontologies';
import { WalkthroughProvider } from './lib/walkthrough';
import { Page, Shell } from './components/Shell';
import { Button, ErrorCard, Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { HubPage } from './pages/Hub';
import { AlphaPage } from './pages/Alpha';
import { FeedbackPage } from './pages/Feedback';
import { SettingsPage } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { OntologyLayout } from './pages/ontology/Layout';
import { OverviewTab } from './pages/ontology/Overview';
import { BrowseTab } from './pages/ontology/Browse';
import { SourceTab } from './pages/ontology/Source';
import { QueryTab } from './pages/ontology/Query';
import { UseCasesTab } from './pages/ontology/UseCases';
import { UseCaseDetailPage } from './pages/ontology/UseCaseDetail';
import { InterviewPage } from './pages/ontology/Interview';
import { MeetingsTab } from './pages/ontology/Meetings';
import { MeetingDetailPage } from './pages/ontology/MeetingDetail';
import { ChangeRequestsTab } from './pages/ontology/ChangeRequests';
import { ChangeRequestPage } from './pages/ontology/ChangeRequestDetail';
import { ReleasesTab } from './pages/ontology/Releases';
import { ReleaseDetailPage } from './pages/ontology/ReleaseDetail';
import { GovernanceTab } from './pages/ontology/Governance';
import { AgentsTab } from './pages/ontology/Agents';

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
  if (!session.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function Routed() {
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/alpha" element={<AlphaPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/" element={<RequireUser><HubPage /></RequireUser>} />
          <Route path="/settings" element={<RequireUser><SettingsPage /></RequireUser>} />
          <Route path="/admin/feedback" element={<RequireUser><AdminFeedbackPage /></RequireUser>} />
          <Route path="/o/:id" element={<RequireUser><OntologyLayout /></RequireUser>}>
            <Route index element={<OverviewTab />} />
            <Route path="browse" element={<BrowseTab />} />
            <Route path="source" element={<SourceTab />} />
            <Route path="query" element={<QueryTab />} />
            <Route path="use-cases" element={<UseCasesTab />} />
            <Route path="use-cases/:useCaseId" element={<UseCaseDetailPage />} />
            <Route path="interview/:sessionId" element={<InterviewPage />} />
            <Route path="meetings" element={<MeetingsTab />} />
            <Route path="meetings/:meetingId" element={<MeetingDetailPage />} />
            <Route path="changes" element={<ChangeRequestsTab />} />
            <Route path="changes/:crId" element={<ChangeRequestPage />} />
            <Route path="releases" element={<ReleasesTab />} />
            <Route path="releases/:releaseId" element={<ReleaseDetailPage />} />
            <Route path="governance" element={<GovernanceTab />} />
            <Route path="agents" element={<AgentsTab />} />
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
