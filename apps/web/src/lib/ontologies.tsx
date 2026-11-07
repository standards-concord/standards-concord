import { createContext, useContext, type ReactNode } from 'react';
import type { OntologySummary } from '@concord/shared';
import { api } from '../api';
import { useAsync, type AsyncState } from './hooks';
import { useSession } from './session';

const Ctx = createContext<AsyncState<OntologySummary[]> | null>(null);

/** App-wide list of ontologies (used by the switcher, hub and walkthrough). */
export function OntologiesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const userId = session?.user?.id;
  const state = useAsync(async () => (userId ? api.ontologies() : []), [userId], { keep: 'ontologies|' });
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useOntologies() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useOntologies outside provider');
  return c;
}

export function useDemoOntology(): OntologySummary | undefined {
  const { data } = useOntologies();
  return data?.find((o) => o.demo) ?? data?.[0];
}
