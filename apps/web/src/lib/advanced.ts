import { useLocalStorage } from './hooks';

/**
 * "Advanced features" (Settings): tools most people won't need stay out of the navigation
 * until this is turned on. Nothing is locked away: an advanced page still opens from a link,
 * and its tab shows while you're on it. Saved in this browser, like the look of the app.
 */
export const ADVANCED_KEY = 'concord.advancedFeatures';

/** Ontology pages (path segments under /o/:id/) that only show in the navigation with advanced features on. */
export const ADVANCED_TABS: ReadonlySet<string> = new Set(['query']);

export function useAdvancedFeatures() {
  return useLocalStorage(ADVANCED_KEY, false);
}
