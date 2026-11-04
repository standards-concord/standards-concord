/**
 * Screen capture of one Chromium tab via the DevTools screencast, streamed into ffmpeg
 * as a constant-frame-rate H.264 video. Playwright's built-in recordVideo is capped at a
 * low bitrate; this keeps text sharp at 1080p.
 *
 * Chromium only sends a frame when something changes, so a ticker repeats the latest
 * frame to hold a steady frame rate against the wall clock. The video's timeline is
 * therefore real time since start(), which the recorder uses to place the narration.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { CDPSession, Page } from '@playwright/test';

export interface CaptureOptions {
  fps: number;
  width: number;
  height: number;
  /** JPEG quality of the frames Chromium sends (0-100). */
  quality: number;
  /** x264 constant rate factor: lower is better quality (18 is visually lossless). */
  crf: number;
}

export class Capture {
  private cdp?: CDPSession;
  private ffmpeg?: ChildProcess;
  private last?: Buffer;
  private written = 0;
  private t0 = 0;
  private timer?: NodeJS.Timeout;
  private done?: Promise<void>;
  private stderr = '';
  /** The most frames' worth of bytes ever queued for ffmpeg at once (it fell behind). */
  peakBacklogBytes = 0;

  constructor(
    private readonly page: Page,
    private readonly out: string,
    private readonly opts: CaptureOptions,
  ) {}

  /** Seconds since capture started: the position in the final video. */
  now() {
    return this.t0 ? (performance.now() - this.t0) / 1000 : 0;
  }

  async start() {
    const { fps, width, height, quality, crf } = this.opts;
    this.ffmpeg = spawn(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-', '-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', String(crf), '-r', String(fps), this.out],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.ffmpeg.stderr!.on('data', (d) => (this.stderr += d));
    this.done = new Promise((resolve, reject) => {
      this.ffmpeg!.on('error', reject);
      this.ffmpeg!.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (video) exited with ${code}: ${this.stderr.slice(-500)}`))));
    });

    this.cdp = await this.page.context().newCDPSession(this.page);
    const first = new Promise<void>((resolve) => {
      this.cdp!.on('Page.screencastFrame', async (f) => {
        this.last = Buffer.from(f.data, 'base64');
        resolve();
        await this.cdp!.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    // Nudge a repaint so the first frame arrives even on a static page.
    await this.page.evaluate(() => document.body && (document.body.style.outline = document.body.style.outline)).catch(() => {});
    await Promise.race([first, new Promise((r) => setTimeout(r, 3000))]);
    this.t0 = performance.now();
    const frameMs = 1000 / fps;
    this.timer = setInterval(() => this.pump(), frameMs / 2);
  }

  private pump() {
    if (!this.last || !this.ffmpeg?.stdin?.writable) return;
    const due = Math.floor(this.now() * this.opts.fps);
    while (this.written < due) {
      // Frames are counted, not timed by ffmpeg, so a slow encoder never shifts the timeline;
      // it only queues bytes in memory. Track that so a run can warn before memory runs out.
      this.ffmpeg.stdin.write(this.last);
      this.written++;
    }
    this.peakBacklogBytes = Math.max(this.peakBacklogBytes, this.ffmpeg.stdin.writableLength);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.pump();
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    this.ffmpeg?.stdin?.end();
    await this.done;
    return this.written / this.opts.fps;
  }
}
