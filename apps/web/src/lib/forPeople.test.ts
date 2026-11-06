import { describe, expect, it } from 'vitest';
import { forPeople } from './forPeople';

describe('forPeople', () => {
  it.each([
    ['When you are happy with A, propose the fork upstream (propose_fork) so the standard can adopt it.', 'When you are happy with A, propose the fork upstream so the standard can adopt it.'],
    ['Create a new fork of Vol (create_fork, or New fork on the Forks page).', 'Create a new fork of Vol (New fork on the Forks page).'],
    ["Redo this fork's changes in the new fork with edit_fork (A, B); get_fork on this fork lists them.", "Redo this fork's changes in the new fork (A, B)."],
    ['A changed since you proposed the fork: call propose_fork again to update change request #4.', 'A changed since you proposed the fork: propose the fork again to update change request #4.'],
    [
      "For each conflict, discard the fork's change (discard_fork_changes) to take upstream's version, then sync (sync_fork) and redo the change with edit_fork if you still need it.",
      "For each conflict, discard the fork's change to take upstream's version, then sync and redo the change if you still need it.",
    ],
    ['Upstream has 2 new commits. Sync the fork (sync_fork) to pick them up; nothing conflicts.', 'Upstream has 2 new commits. Sync the fork to pick them up; nothing conflicts.'],
  ])('%s', (from, to) => expect(forPeople(from)).toBe(to));

  it('leaves other brackets alone', () => expect(forPeople('Switch back to the release (now at 1.2.0).')).toBe('Switch back to the release (now at 1.2.0).'));
});
