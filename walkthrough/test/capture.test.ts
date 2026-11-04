import { describe, expect, it } from 'vitest';
import { Capture } from '../lib/capture.ts';

describe('capture back-pressure', () => {
  it('never queues more than the cap for a stalled encoder', () => {
    const queued: Buffer[] = [];
    const stdin = {
      writable: true,
      destroyed: false,
      get writableLength() {
        return queued.reduce((n, b) => n + b.length, 0);
      },
      write(b: Buffer) {
        queued.push(b); // a stalled encoder: nothing is ever drained
        return false;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    const saved = Capture.maxBacklogBytes;
    Capture.maxBacklogBytes = 1000;
    try {
      const cap = new Capture({} as any, 'x.mp4', { fps: 30, width: 1, height: 1, quality: 50, crf: 20 }) as any;
      cap.ffmpeg = { stdin };
      cap.last = Buffer.alloc(100);
      cap.t0 = performance.now() - 10_000; // 300 frames are due
      cap.pump();
      expect(stdin.writableLength).toBeLessThanOrEqual(1000);
      expect(stdin.destroyed).toBe(true);
      expect(() => cap.check()).toThrow(/fell more than/);
    } finally {
      Capture.maxBacklogBytes = saved;
    }
  });
});
