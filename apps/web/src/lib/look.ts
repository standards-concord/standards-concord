/**
 * Visual "looks": whole-app styles swapped by one attribute on <html>.
 *
 * Every look is a set of CSS variables in index.css (colours, fonts, radii, shadows),
 * so components never name a look. `?look=<id>` in any URL switches and remembers it,
 * which is how reviewers compare them on the live site.
 */
export const LOOKS = [
  {
    id: 'spec',
    name: 'Specification',
    blurb: 'Standards-document typography: serif headings, paper tones, hairline rules and a W3C-style blue.',
  },
  {
    id: 'civic',
    name: 'Civic grid',
    blurb: 'Swiss and civic design: a strong grotesque, black rules, square corners and one signal colour.',
  },
  {
    id: 'workbench',
    name: 'Workbench',
    blurb: 'An engineering tool: IBM Plex, a dark masthead, compact monospace labels and a green accent.',
  },
  {
    id: 'classic',
    name: 'Original',
    blurb: 'The first prototype style, kept for comparison.',
  },
] as const;

export type LookId = (typeof LOOKS)[number]['id'];
export const DEFAULT_LOOK: LookId = 'spec';
const KEY = 'concord-look';

export function isLook(v: unknown): v is LookId {
  return LOOKS.some((l) => l.id === v);
}

export function storedLook(): LookId {
  try {
    const v = localStorage.getItem(KEY);
    return isLook(v) ? v : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

export function applyLook(id: LookId, persist = true) {
  document.documentElement.dataset.look = id;
  if (persist) {
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private mode: the look still applies for this page */
    }
  }
  window.dispatchEvent(new CustomEvent('concord-look', { detail: id }));
}

/**
 * Run once before the first render: a valid ?look= wins and is remembered, else the
 * remembered look, else the default. The inline script in index.html applies the same
 * rules before first paint; e2e/looks.spec.ts checks they agree.
 */
export function initLook() {
  const param = new URLSearchParams(window.location.search).get('look');
  applyLook(isLook(param) ? param : storedLook(), isLook(param));
}

/** A choice made in the app replaces any ?look= in the address, so a reload keeps it. */
export function chooseLook(id: LookId) {
  applyLook(id);
  const url = new URL(window.location.href);
  if (url.searchParams.has('look')) {
    url.searchParams.delete('look');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
}

export function currentLook(): LookId {
  const v = document.documentElement.dataset.look;
  return isLook(v) ? v : DEFAULT_LOOK;
}
