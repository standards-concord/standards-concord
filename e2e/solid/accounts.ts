/** The Solid server and accounts the Solid end-to-end tests use (seeded from seed.json). */
export const CSS_PORT = Number(process.env.E2E_CSS_PORT ?? 3990);
export const CSS = `http://localhost:${CSS_PORT}`;

export const SOLID = {
  css: CSS,
  /** Listed in ADMIN_WEBIDS. */
  admin: { webId: `${CSS}/admin/profile/card#me`, email: 'admin@example.org', password: 'admin-password' },
  visitor: { webId: `${CSS}/visitor/profile/card#me`, email: 'visitor@example.org', password: 'visitor-password' },
};
