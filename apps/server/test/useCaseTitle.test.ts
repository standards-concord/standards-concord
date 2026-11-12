import { expect, it } from 'vitest';
import { interviewTitle } from '../src/services/useCaseTitle.js';

// First answers used to leave legacy default names or cut a title in the middle of a word.
it('uses the first sentence, trims punctuation and stops at a word boundary within 60 characters', () => {
  expect(interviewTitle(undefined, 'Tom Okafor', '  Find local shifts for students! Then apply.  ')).toBe('Find local shifts for students');
  expect(interviewTitle("Tom Okafor's use case", 'Tom Okafor', 'Find volunteering opportunities for students who need accessible transport nearby.')).toBe('Find volunteering opportunities for students who need');
  expect(interviewTitle('Tom Okafor’s use case', 'Tom Okafor', 'Match volunteers:  ')).toBe('Match volunteers');
  expect(interviewTitle(undefined, 'Tom Okafor', 'x'.repeat(80))).toBe('x'.repeat(60));
});

it('preserves titles already set by a person or the interviewer', () => {
  expect(interviewTitle('Match volunteers', 'Tom Okafor', 'A different answer.')).toBe('Match volunteers');
  expect(interviewTitle("Someone else's use case", 'Tom Okafor', 'A different answer.')).toBe("Someone else's use case");
  expect(interviewTitle(undefined, 'Tom Okafor', '   ')).toBeUndefined();
});
