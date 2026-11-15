import { useEffect, useRef, useState } from 'react';
import { IcuStreamEvent, routes } from '@clinic/contracts';
import { getToken } from './api';

// Server-Sent Events over fetch (not EventSource): EventSource cannot send an Authorization header, and the token
// must never travel in the URL (logs, history, Referer). The parser follows the SSE wire format:
// events are separated by a blank line, `data:` lines of one event are joined with '\n', lines starting with ':'
// are comments (keep-alive), CRLF and LF are both accepted, and a chunk may end anywhere (mid-line, mid-event).

export interface SseParser {
  push(chunk: string): void;
}

export function createSseParser(onData: (data: string) => void): SseParser {
  let buf = '';
  let data: string[] = [];
  const flushLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      if (data.length) onData(data.join('\n'));
      data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    // `event`, `id`, `retry` are not used by /api/icu/stream (the event type is inside the JSON)
  };
  return {
    push(chunk) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
  };
}

/** Reads one SSE response to its end; resolves when the server closes the stream, rejects on HTTP / network errors. */
export async function readSse(
  url: string,
  token: string | null,
  onEvent: (e: IcuStreamEvent) => void,
  signal: AbortSignal,
  onOpen: () => void = () => {},
): Promise<void> {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal });
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  onOpen();
  const parser = createSseParser((data) => {
    const parsed = IcuStreamEvent.safeParse(JSON.parse(data));
    if (parsed.success) onEvent(parsed.data);
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    parser.push(value);
  }
}

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'error';

/** Live ICU stream with reconnect: 1 s, 2 s, 4 s … up to 15 s; the delay resets after a successful connection. */
export function useIcuStream(onEvent: (e: IcuStreamEvent) => void, enabled = true): StreamState {
  const [state, setState] = useState<StreamState>('connecting');
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let delay = 1000;
    const url = (import.meta.env.VITE_API_URL ?? '') + routes.icuStream.path;
    void (async () => {
      while (!ctl.signal.aborted) {
        try {
          await readSse(url, getToken(), (e) => handler.current(e), ctl.signal, () => {
            delay = 1000;
            setState('open');
          });
        } catch {
          if (ctl.signal.aborted) return;
          setState('error');
        }
        if (ctl.signal.aborted) return;
        setState('reconnecting');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    })();
    return () => ctl.abort();
  }, [enabled]);
  return state;
}
