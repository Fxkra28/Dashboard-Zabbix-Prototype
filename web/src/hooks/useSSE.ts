import { useEffect, useState } from 'react';
import { api, getToken } from '../api';

/**
 * Subscribe to one named SSE event; returns the latest payload, when it
 * arrived, connection state, and the last error the stream reported.
 *
 * Two failures used to be silent:
 *
 *   - The BFF reports a failed Zabbix read as an `event: error` frame. Nothing
 *     listened for it, so the badge kept saying "Live" over data that had
 *     stopped updating.
 *   - EventSource cannot see HTTP status. When the token in the URL expired it
 *     reconnected with the same dead token every few seconds, forever, and the
 *     user was never sent back to sign in. On a dropped connection with a token
 *     in play, one authenticated call settles it: `request()` turns a 401 into
 *     a sign-out.
 *
 * A hidden tab has no use for live frames, so the stream closes while the tab
 * is hidden and reopens on return. `connected` keeps its last value meanwhile:
 * the page should not fall back to polling just because it is in the background.
 */
export function useSSE<T>(url: string, event: string) {
  const [data, setData] = useState<T | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let checkingAuth = false;

    const open = () => {
      const source = new EventSource(url);
      es = source;

      source.onopen = () => setConnected(true);

      // Both a server-sent `event: error` frame and a dropped connection arrive
      // here. Only the frame carries data.
      source.onerror = (e) => {
        const raw = (e as MessageEvent).data;
        setConnected(false);
        if (typeof raw === 'string') {
          try {
            setError((JSON.parse(raw) as { message?: string }).message ?? 'The live stream reported an error.');
          } catch {
            setError('The live stream reported an error.');
          }
          return;
        }
        if (getToken() && !checkingAuth) {
          checkingAuth = true;
          void api
            .me()
            .catch(() => undefined)
            .finally(() => {
              checkingAuth = false;
            });
        }
      };

      source.addEventListener(event, (e) => {
        try {
          setData(JSON.parse((e as MessageEvent).data));
          setUpdatedAt(Date.now());
          setConnected(true);
          setError(null);
        } catch {
          /* ignore malformed frame */
        }
      });
    };

    const close = () => {
      es?.close();
      es = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') close();
      else if (!es) open();
    };

    if (document.visibilityState !== 'hidden') open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [url, event]);

  return { data, updatedAt, connected, error };
}
