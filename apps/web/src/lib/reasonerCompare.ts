import type { ReasonerResult } from '@concord/core/types';

/** How far a reasoner run got; reports stored before `checked` existed count as complete when available. */
export const checkedOf = (r: ReasonerResult) => r.checked ?? (r.available ? 'complete' : 'none');
