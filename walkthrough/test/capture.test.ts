import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { hasChromium } from '../lib/browser.ts';
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

describe('capture timeline', () => {
  // Frames used to be placed when they reached the recorder, so on a busy machine the
  // picture lagged the narration by however long frames took to arrive.
  it('places each frame at the time Chromium painted it, not when it arrived', () => {
    const written: string[] = [];
    const cap = new Capture({} as any, 'x.mp4', { fps: 10, width: 1, height: 1, quality: 50, crf: 20 }) as any;
    cap.ffmpeg = { stdin: { writable: true, writableLength: 0, write: (b: Buffer) => written.push(b.toString()) } };
    let now = 0;
    cap.now = () => now;
    cap.receive(Buffer.from('A')); // the opening picture, before start
    cap.t0 = 1;
    const wall = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(wall);
    try {
      now = 1.0;
      cap.receive(Buffer.from('B'), (wall - 500) / 1000); // painted at 0.5 s, arrived at 1.0 s
      now = 1.3;
      cap.pump(); // writes up to 1.0 s (0.3 s behind real time)
      expect(written.join('')).toBe('AAAAABBBBB');
      now = 2.0;
      cap.receive(Buffer.from('C'), (wall - 1500) / 1000); // painted at 0.5 s: its place is already written
      cap.pump(0);
      expect(written.join('')).toBe('AAAAABBBBB' + 'CCCCCCCCCC');
      expect(cap.latency()).toMatchObject({ frames: 2, maxMs: 1500, tooLate: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

// A real recording: the page turns green at a known moment, and the video must show it
// within a frame or two of that moment. Needs Playwright's Chromium and ffmpeg.
const required = process.env.WALKTHROUGH_BROWSER_TESTS === '1';
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
describe.runIf(required || (hasChromium() && hasFfmpeg))('capture alignment', () => {
  it('shows a change at the moment it happened, even when frames arrive late', { timeout: 60_000 }, async () => {
    // Every frame reaches the recorder 250 ms after it was painted, as on a busy machine.
    Capture.deliveryDelayMs = 250;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-'));
    const out = path.join(dir, 'sync.mp4');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
      await page.setContent('<body style="margin:0;background:#f00;height:100vh"></body>');
      const cap = new Capture(page, out, { fps: 30, width: 320, height: 180, quality: 80, crf: 20 });
      await cap.start();
      await new Promise((r) => setTimeout(r, 1000));
      const changedAt = cap.now();
      await page.evaluate(() => (document.body.style.background = '#0f0'));
      await new Promise((r) => setTimeout(r, 1000));
      await cap.stop();
      // The green of each frame's centre pixel, frame by frame.
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'crop=16:16:152:82,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const firstGreen = [...Array(raw.length / 3).keys()].findIndex((i) => raw[i * 3 + 1] > 128 && raw[i * 3] < 128);
      expect(firstGreen).toBeGreaterThan(0);
      // Within 100 ms of the change: the paint itself takes a frame or so.
      expect(Math.abs(firstGreen / 30 - changedAt)).toBeLessThan(0.1);
    } finally {
      Capture.deliveryDelayMs = 0;
      await browser.close();
    }
  });
});
