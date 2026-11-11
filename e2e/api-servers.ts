/** Shared by Playwright's server setup and the specs; importing it has no setup side effects. */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8797);
/** Only the packaged-function mode supports two processes on the same Postgres database. */
export const API_URL_B = process.env.E2E_API === 'vercel' && process.env.E2E_TWO_SERVERS === '1'
  ? `http://localhost:${Number(process.env.E2E_API_PORT_B ?? API_PORT + 3)}`
  : undefined;
