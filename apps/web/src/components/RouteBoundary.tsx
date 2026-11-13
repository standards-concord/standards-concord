import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { RouteChunkError } from '../lib/routeChunks';
import { reloadApp, reloadForChunkFailure } from '../lib/appUpdate';
import { Button, Loading } from './ui';

function DelayedLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <Loading /> : null;
}

class ChunkBoundary extends Component<{ children: ReactNode; resetKey: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    if (error instanceof RouteChunkError) reloadForChunkFailure();
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }
  render() {
    const { error } = this.state;
    if (error && !(error instanceof RouteChunkError)) throw error;
    if (error) return (
      <div role="status" aria-live="polite" className="mx-auto max-w-3xl px-4 py-12 text-sm">
        <p>This page isn't available offline yet. Reconnect and try again.</p>
        {/* A document reload also clears the browser's cache of failed module imports. */}
        <Button className="mt-4" onClick={() => void reloadApp()}>Retry</Button>
      </div>
    );
    return this.props.children;
  }
}

/** Each layout keeps its navigation mounted while only its content loads or needs Retry. */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ChunkBoundary resetKey={pathname}>
      <Suspense fallback={<DelayedLoading />}>{children}</Suspense>
    </ChunkBoundary>
  );
}
