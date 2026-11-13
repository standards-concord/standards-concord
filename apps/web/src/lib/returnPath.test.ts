import { describe, expect, it } from 'vitest';
import { returnPath } from './returnPath';

describe('sign-in return destination', () => {
  it('keeps invitation paths and other local destinations intact', () => {
    expect(returnPath('/join/private-token')).toBe('/join/private-token');
    expect(returnPath('/o/one/governance#roles')).toBe('/o/one/governance#roles');
    expect(returnPath('/browse?query=one%20two')).toBe('/browse?query=one%20two');
  });

  it('refuses external URLs and paths a browser normalises into an external URL', () => {
    for (const path of [null, '', 'https://example.org', '//example.org', '/\\example.org', '/\t/example.org', '/\n/example.org', '/\rexample.org'])
      expect(returnPath(path)).toBe('/');
  });
});
