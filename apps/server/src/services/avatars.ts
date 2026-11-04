import type { User } from '@concord/shared';

/**
 * Profile pictures for demo accounts. The images are committed under
 * apps/web/public/avatars (see scripts/generate-avatars.mjs), so they are served
 * by the web app itself: no third-party requests, and the demo works offline.
 * Accounts from Google or GitHub keep the provider's picture; anyone without a
 * picture, or whose picture fails to load, still gets their initials.
 */

/** Size of the pool in avatars/demo. Keep in step with scripts/generate-avatars.mjs. */
export const DEMO_AVATAR_COUNT = 24;

export const personaAvatarUrl = (key: string) => `/avatars/personas/${key}.svg`;

/** A stable picture from the pool, picked by a hash of the account id (FNV-1a). */
export function demoAvatarUrl(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return `/avatars/demo/${String((h >>> 0) % DEMO_AVATAR_COUNT).padStart(2, '0')}.svg`;
}

/** The picture a demo account should have, or undefined for real sign-ins. */
export function demoAvatarFor(u: Pick<User, 'id' | 'providers'>): string | undefined {
  const demo = u.providers.find((p) => p.provider === 'demo');
  if (!demo) return undefined;
  const persona = /^persona:(.+)$/.exec(demo.subject)?.[1];
  return persona ? personaAvatarUrl(persona) : demoAvatarUrl(u.id);
}
