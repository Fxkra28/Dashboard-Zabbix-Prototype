import { useEffect, useRef, useState } from 'react';

/** Subscribe to one named SSE event; returns latest payload + connection state. */
export function useSSE<T>(url: string, event: string) {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener(event, (e) => {
      try {
        setData(JSON.parse((e as MessageEvent).data));
        setConnected(true);
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => es.close();
  }, [url, event]);

  return { data, connected };
}
