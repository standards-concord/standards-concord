/**
 * Lays the narration clips onto the recorded video at the moments they were spoken,
 * writes WebVTT captions, and muxes everything into one MP4 (H.264, AAC, soft subtitles).
 */
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Placed {
  file: string;
  /** Seconds from the start of the video. */
  at: number;
  duration: number;
  text: string;
  /** Caption cues, in seconds from the clip's start. */
  cues: { start: number; end: number; text: string }[];
}

function ts(s: number) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/** WebVTT captions from each clip's cues. */
export function vtt(clips: Placed[]): string {
  const cues: string[] = ['WEBVTT', ''];
  let n = 1;
  const all = clips.flatMap((c) => c.cues.map((q) => ({ start: c.at + q.start, end: c.at + q.end, text: q.text })));
  all.forEach((q, i) => {
    // At least 0.4 s on screen, but never overlapping the next cue.
    const next = all[i + 1]?.start ?? Infinity;
    const end = Math.min(Math.max(q.end, q.start + 0.4), Math.max(next, q.end));
    cues.push(String(n++), `${ts(q.start)} --> ${ts(end)}`, q.text, '');
  });
  return cues.join('\n');
}

/** FFMETADATA with one chapter per scene, so players show a chapter list. */
export function ffmetadata(chapters: { at: number; title: string }[], end: number, title?: string) {
  const esc = (s: string) => s.replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${esc(title)}`);
  chapters.forEach((c, i) => {
    const stop = chapters[i + 1]?.at ?? end;
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.at * 1000)}`, `END=${Math.round(stop * 1000)}`, `title=${esc(c.title)}`);
  });
  return lines.join('\n') + '\n';
}

export async function mux(opts: { video: string; videoSeconds: number; clips: Placed[]; out: string; captions: string; chapters?: { at: number; title: string }[]; title?: string }) {
  await writeFile(opts.captions, vtt(opts.clips));
  const meta = `${opts.out}.ffmeta`;
  await writeFile(meta, ffmetadata(opts.chapters ?? [], opts.videoSeconds, opts.title));
  const args = ['-v', 'error', '-y', '-i', opts.video];
  for (const c of opts.clips) args.push('-i', c.file);
  args.push('-i', opts.captions, '-i', meta);
  const subIndex = opts.clips.length + 1;
  const metaIndex = opts.clips.length + 2;
  const filters: string[] = [];
  const labels: string[] = [];
  opts.clips.forEach((c, i) => {
    const delay = Math.round(c.at * 1000);
    filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  let audioMap: string[];
  if (opts.clips.length) {
    // normalize=0 keeps each clip at its own level (they never overlap anyway).
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=0:${opts.videoSeconds.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    audioMap = ['-map', '[aout]'];
  } else {
    audioMap = [];
  }
  args.push('-filter_complex_threads', '1');
  if (filters.length) args.push('-filter_complex', filters.join(';'));
  args.push('-map', '0:v', ...audioMap, '-map', `${subIndex}:s`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-movflags', '+faststart');
  args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
  args.push('-t', opts.videoSeconds.toFixed(3), opts.out);
  try {
    await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
  } finally {
    await rm(meta, { force: true });
  }
}
