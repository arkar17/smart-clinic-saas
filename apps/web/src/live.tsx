import { useEffect, useRef, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';
/** 4xx (except 429) means the credential is invalid: stop retrying. */
class FatalStreamError extends Error {}

/**
 * Shared SSE hook (SC3-FE-05, ADR-027): fetch-based so credentials travel in headers, never in the URL.
 * On every (re)open the caller reloads its REST snapshot; Last-Event-ID is sent automatically on reconnect.
 */
export function useLive(path: string | null, headers: Record<string, string>, onEvent: (event: string, data: unknown) => void, onOpen: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef({ onEvent, onOpen });
  cb.current = { onEvent, onOpen };
  const headerKey = JSON.stringify(headers);
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    let delay = 1000;
    void fetchEventSource(`/api${path}`, {
      headers: JSON.parse(headerKey),
      credentials: 'same-origin',
      signal: ctrl.signal,
      openWhenHidden: true,
      async onopen(res) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new FatalStreamError(`stream ${res.status}`);
        if (!res.ok) throw new Error(`stream ${res.status}`);
        delay = 1000;
        setState('live');
        cb.current.onOpen();
      },
      onmessage(msg) {
        if (msg.event) cb.current.onEvent(msg.event, msg.data ? JSON.parse(msg.data) : null);
      },
      onclose() {
        setState('reconnecting');
        throw new Error('closed'); // let onerror schedule the retry
      },
      onerror(err) {
        if (err instanceof FatalStreamError) {
          setState('offline');
          throw err; // stops fetch-event-source retrying
        }
        setState('reconnecting');
        delay = Math.min(30_000, delay * 2);
        return delay + Math.random() * 500; // back off 1–30 s with jitter (Arch 19.3)
      },
    }).catch(() => undefined);
    return () => ctrl.abort();
  }, [path, headerKey]);
  return state;
}

export const LiveBadge = ({ state }: { state: LiveState }) => (
  <span role="status" className={`rounded px-2 py-0.5 text-xs ${state === 'live' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
    {state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Reconnecting…'}
  </span>
);
