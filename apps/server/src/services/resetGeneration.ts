import { get, put } from '../db.js';

const KEY = 'reset-generation';
export const resetGeneration = async () => (await get<{ count: number }>('kv', KEY))?.count ?? 0;

/** Called in the reset transaction, after the wipe, with the preceding generation. */
export const saveResetGeneration = async (previous: number) => { await put('kv', { id: KEY, count: previous + 1 }); };

export class SeedResetError extends Error {
  constructor() { super('Sample seed stopped because the dataset was reset'); }
}
