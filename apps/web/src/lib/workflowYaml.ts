/**
 * The workflow file to add to an app's repository. Nothing user-provided goes in it except the
 * Concord URL, written as a quoted YAML string so it can't add keys or steps.
 */
export function workflowYaml(concordUrl: string) {
  return `# .github/workflows/concord.yml
# Tests this app against every change proposed to the ontology on Concord.
name: Concord ontology checks
on:
  schedule:
    - cron: '*/30 * * * *'   # every 30 minutes (GitHub can delay scheduled runs)
  workflow_dispatch:
jobs:
  concord:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write   # lets GitHub vouch for the run, so autopilot can trust its results
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: jeswr/standards-concord/actions/app-check@main
        with:
          concord-url: ${JSON.stringify(concordUrl)}
          token: \${{ secrets.CONCORD_APP_TOKEN }}
          test-command: npm test
          # If your app keeps a copy of the ontology, give its path and it is swapped
          # for each proposed version. Otherwise read $CONCORD_ONTOLOGY_FILE in your tests.
          # ontology-file: data/ontology.ttl
`;
}
