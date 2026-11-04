# Working on Concord

## Tests are part of every change

- **Every feature ships with Playwright tests** in `e2e/<feature>.spec.ts` that drive it the way a person would: through the UI, as a role that is allowed to do it, and as one that isn't. Import `test` from `e2e/fixtures.ts`, which fails a test on any console error, uncaught exception or crash screen.
- **Every bug fix ships with a Playwright test that reproduces the bug.** Write the test first and watch it fail on the unfixed code, then fix. Name the behaviour in the test title, and add a short comment saying what used to go wrong, so nobody deletes it as redundant. If a browser test genuinely can't reach the bug (e.g. a server-only race), add an API or unit test instead and say why in the PR.
- **Keep [docs/e2e-coverage.md](docs/e2e-coverage.md) current.** When you add a page, route, role rule or flow, add its row and the spec that covers it. A row marked as a gap is a bug in the test suite.
- Never skip, quarantine or loosen a test to get CI green. A flaky test is a bug: find the race and fix it (in the app if the app is at fault).

## How the e2e suite works

- `pnpm test:e2e` boots its own API server (port 8797, throwaway data directory, offline LLM stand-in, demo mode) and web app (port 5183). `E2E_MODE=preview` tests the production build. To reuse servers you already started, set `E2E_API_PORT` / `E2E_WEB_PORT` and run without `CI`.
- All specs share one server, one dataset and one simulated clock, and run one file at a time. So:
  - Give anything you create a unique name (`uniq()` from the fixtures), and don't assume counts in the demo data.
  - A flow that changes settings (governance policy, members, releases) should create its own ontology rather than edit the shared demo one (see `e2e/governance-flow.spec.ts`).
  - The clock only moves forward; advancing it (`POST /api/simulation/clock`) affects later specs' relative dates.
- Sign in with `signIn(page, { name, role })` (a new tester each call) or `signInAsPersona(page, 'Tom Okafor')` (a simulated working-group member with fixed roles: Priya steward/owner, Tom editor, Aisha contributor, Gareth and Mei reviewers, Daniel ODI).
- Prefer role-based locators (`getByRole`, `getByLabel`). If a control can't be found that way, that is usually an accessibility bug in the app: give it a name rather than reaching for a CSS selector.
