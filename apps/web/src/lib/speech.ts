import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';

/* Minimal typings for the Web Speech API (not in lib.dom for all TS versions). */
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type DictationMode = 'speech' | 'recorder' | 'none';

export function dictationSupport(): DictationMode {
  if (getRecognitionCtor()) return 'speech';
  if (typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') return 'recorder';
  return 'none';
}

/**
 * Live dictation. With the Web Speech API you get interim text while speaking;
 * otherwise records audio and sends it to POST /api/transcribe when stopped.
 *
 * onText(finalText) is called with each finalised chunk; `interim` holds the
 * current unfinalised text so the input can show it live.
 */
export function useDictation(onText: (text: string) => void, opts: { allowRecorderFallback?: boolean } = {}) {
  const [mode] = useState<DictationMode>(() => {
    const m = dictationSupport();
    return m === 'recorder' && opts.allowRecorderFallback === false ? 'none' : m;
  });
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recRef.current?.stop();
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(undefined);
    if (mode === 'speech') {
      const Ctor = getRecognitionCtor()!;
      const rec = new Ctor();
      rec.lang = navigator.language || 'en-GB';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) onTextRef.current(r[0].transcript.trim());
          else interimText += r[0].transcript;
        }
        setInterim(interimText);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('Microphone permission was denied.');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') setError(`Voice input error: ${e.error}`);
      };
      rec.onend = () => {
        setListening(false);
        setInterim('');
        recRef.current = null;
      };
      recRef.current = rec;
      try {
        rec.start();
        setListening(true);
      } catch {
        setError('Could not start voice input.');
      }
      return;
    }
    if (mode === 'recorder') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setListening(false);
          mediaRef.current = null;
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          if (!blob.size) return;
          setTranscribing(true);
          try {
            const { text } = await api.transcribe(blob);
            if (text?.trim()) onTextRef.current(text.trim());
          } catch (err) {
            if (err instanceof ApiError && err.status === 501) {
              setUnavailable(true);
              setError("Voice input isn't available in this browser — please type your answer instead.");
            } else if (err instanceof ApiError && err.status === 413) {
              // Over the server's size limit (4 MB on Vercel, about 15 minutes of speech).
              setError('That recording is too long to send. Try again in shorter parts.');
            } else setError(err instanceof Error ? err.message : 'Transcription failed.');
          } finally {
            setTranscribing(false);
          }
        };
        mediaRef.current = mr;
        mr.start();
        setListening(true);
      } catch {
        setError('Microphone permission was denied.');
      }
    }
  }, [mode]);

  const toggle = useCallback(() => (listening ? stop() : void start()), [listening, start, stop]);

  useEffect(() => () => {
    recRef.current?.abort();
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop();
  }, []);

  return { mode: unavailable ? ('none' as DictationMode) : mode, supported: mode !== 'none' && !unavailable, listening, interim, transcribing, error, start, stop, toggle };
}
