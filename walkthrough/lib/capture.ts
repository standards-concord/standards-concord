/**
 * Screen capture of one Chromium tab via the DevTools screencast, streamed into ffmpeg
 * as a constant-frame-rate H.264 video. Playwright's built-in recordVideo is capped at a
 * low bitrate; this keeps text sharp at 1080p.
 *
 * Chromium only sends a frame when something changes, so a ticker repeats the latest
 * frame to hold a steady frame rate against the wall clock. The video's timeline is
 * therefore real time since start(), which the recorder uses to place the narration.
 *
 * Frames reach us some time after Chromium painted them, and longer when the machine is
 * busy. Each frame is placed at the time it was painted (the screencast's own
 * timestamp), not when it arrived: the ticker writes a short while behind real time so
 * late frames still land where they belong. Otherwise the picture would lag the
 * narration by however long frames took to arrive.
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
  /** Frames received but not yet due, with the time (seconds since start) they were painted. */
  private queue: { buf: Buffer; t: number }[] = [];
  /** How long after painting each frame arrived, in milliseconds. */
  private delays: number[] = [];
  /** Frames that arrived after their place in the video had already been written. */
  private tooLate = 0;
  /** How far behind real time frames are written, so late ones still fit. */
  static holdSeconds = 0.3;
  /** Holds back every frame this long before it is taken, as a busy machine would (tests). */
  static deliveryDelayMs = 0;
  private written = 0;
  private t0 = 0;
  private timer?: NodeJS.Timeout;
  private done?: Promise<void>;
  private stderr = '';
  /** The most frames' worth of bytes ever queued for ffmpeg at once (it fell behind). */
  peakBacklogBytes = 0;
  /** Past this much queued video, give up rather than run the machine out of memory. */
  static maxBacklogBytes = 1024 * 1024 * 1024;
  private overrun?: Error;

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
        const take = () => this.receive(Buffer.from(f.data, 'base64'), f.metadata?.timestamp);
        if (Capture.deliveryDelayMs && this.t0) setTimeout(take, Capture.deliveryDelayMs);
        else take();
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

  /** Takes a frame, painted at `paintedAt` (seconds since the epoch, from Chromium). */
  private receive(buf: Buffer, paintedAt?: number) {
    if (!this.t0) {
      this.last = buf; // before start: the opening picture
      return;
    }
    // Only the delay comes from the wall clock, so clock adjustments can't move frames.
    const delay = paintedAt ? Math.max(0, Date.now() - paintedAt * 1000) : 0;
    this.delays.push(delay);
    const t = this.now() - delay / 1000;
    if (t < this.written / this.opts.fps) this.tooLate++;
    // Frames arrive in paint order; keep the queue sorted in case one doesn't.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].t > t) i--;
    this.queue.splice(i, 0, { buf, t });
  }

  /** Writes every frame now due: up to `hold` seconds before real time. */
  private pump(hold = Capture.holdSeconds) {
    if (this.overrun || !this.ffmpeg?.stdin?.writable) return;
    const stdin = this.ffmpeg.stdin;
    const due = Math.floor(Math.max(0, this.now() - hold) * this.opts.fps);
    while (this.written < due) {
      // Show the newest frame painted by this frame's time.
      const at = this.written / this.opts.fps;
      while (this.queue.length && this.queue[0].t <= at) this.last = this.queue.shift()!.buf;
      if (!this.last) return;
      // Frames are counted, not timed by ffmpeg, so a slow encoder never shifts the timeline;
      // it only queues bytes in memory (Node's back-pressure signal). That queue is capped
      // here, before every write: past the cap the recording stops instead of growing.
      if (stdin.writableLength + this.last.length > Capture.maxBacklogBytes) {
        this.overrun = new Error(`The video encoder fell more than ${Math.round(Capture.maxBacklogBytes / 1048576)} MB behind; record on a faster machine`);
        clearInterval(this.timer);
        stdin.destroy();
        return;
      }
      stdin.write(this.last);
      this.written++;
      this.peakBacklogBytes = Math.max(this.peakBacklogBytes, stdin.writableLength);
    }
  }

  /** How long frames took to arrive after painting (ms), and how many came too late to place. */
  latency() {
    const d = [...this.delays].sort((a, b) => a - b);
    const q = (p: number) => (d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(p * d.length))]) : 0);
    return { frames: d.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: d.length ? Math.round(d[d.length - 1]) : 0, tooLate: this.tooLate };
  }

  /** Throws if capture had to stop early; scenes call this between steps so a run fails fast. */
  check() {
    if (this.overrun) throw this.overrun;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.pump(0);
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    if (this.overrun) {
      await this.done?.catch(() => {});
      throw this.overrun;
    }
    this.ffmpeg?.stdin?.end();
    await this.done;
    return this.written / this.opts.fps;
  }
}
