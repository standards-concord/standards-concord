import { describe, expect, it } from 'vitest';
import { acceptedOnSilence } from './governanceRules';

describe('acceptedOnSilence', () => {
  it('lets silence decide patch and minor levels under lazy consensus', () => {
    expect(acceptedOnSilence({ lazyConsensus: true }, 'patch')).toBe(true);
    expect(acceptedOnSilence({ lazyConsensus: true }, 'minor')).toBe(true);
  });
  it('never lets silence decide a major level, which still needs its sign-offs and vote', () => {
    expect(acceptedOnSilence({ lazyConsensus: true }, 'major')).toBe(false);
  });
  it('needs lazy consensus to be on', () => {
    expect(acceptedOnSilence({ lazyConsensus: false }, 'patch')).toBe(false);
  });
});
