/**
 * The workflow file to add to an app's repository. Nothing user-provided goes in it except the
 * Concord URL and the app's id, each written as a quoted YAML string so it can't add keys or steps.
 * The action is used from its public copy (standards-concord/app-check, see scripts/publish-action.sh),
 * so any repository can use it whether or not this one is public.
 *
 * With `app` (an app connected through the Concord GitHub App) the workflow has no secret: the
 * run proves itself with GitHub's own token, and Concord starts it whenever there is something
 * new to test, so the schedule is only a daily backstop. Without it, the run signs in with the
 * app token stored as a repository secret and checks every 30 minutes.
 */
export function workflowYaml(concordUrl: string, opts: { app?: string } = {}) {
  const viaApp = opts.app !== undefined;
  const schedule = viaApp
    ? `    - cron: '17 6 * * *'   # daily backstop: Concord starts a run whenever there is something new to test`
    : `    - cron: '*/30 * * * *'   # every 30 minutes (GitHub can delay scheduled runs)`;
  const auth = viaApp ? `          app: ${JSON.stringify(opts.app)}` : `          token: \${{ secrets.CONCORD_APP_TOKEN }}`;
  return `# .github/workflows/concord.yml
# Tests this app against every change proposed to the ontology on Concord.
name: Concord ontology checks
on:
  schedule:
${schedule}
  workflow_dispatch:
jobs:
  concord:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write   # lets GitHub vouch for the run${viaApp ? ' (it is also how the run signs in)' : ', so autopilot can trust its results'}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: standards-concord/app-check@v1
        with:
          concord-url: ${JSON.stringify(concordUrl)}
${auth}
          test-command: npm test
          # If your app keeps a copy of the ontology, give its path and it is swapped
          # for each proposed version. Otherwise read $CONCORD_ONTOLOGY_FILE in your tests.
          # ontology-file: data/ontology.ttl
`;
}
