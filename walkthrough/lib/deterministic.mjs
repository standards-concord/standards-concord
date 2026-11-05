/**
 * Preloaded into the Concord server the walkthrough starts (via NODE_OPTIONS --import),
 * so each recording shows the same dates and ids:
 *
 *   WALKTHROUGH_EPOCH  the server's clock starts at this moment and runs normally from it
 *   WALKTHROUGH_SEED   crypto.randomUUID() returns a seeded sequence instead of random ids
 *
 * Only ever used for the throwaway local server a recording runs against. Tokens and
 * other secrets use randomBytes, which this leaves alone.
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const epoch = Date.parse(process.env.WALKTHROUGH_EPOCH ?? '');
if (Number.isFinite(epoch)) {
  const RealDate = Date;
  const shift = epoch - RealDate.now();
  class WalkthroughDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = WalkthroughDate;
}

const seed = process.env.WALKTHROUGH_SEED;
if (seed) {
  let n = 0;
  crypto.randomUUID = () => {
    const b = crypto.createHash('sha256').update(`${seed}:${n++}`).digest();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = b.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
  };
  syncBuiltinESMExports();
}
