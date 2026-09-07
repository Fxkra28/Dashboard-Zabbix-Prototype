import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Which optional BFF capabilities are configured?
 *
 * One /api/health probe shared by every page. Pages hide actions that aren't
 * available — an "Explain" button with no API key, or an "Ack" button with no
 * write token — rather than offering something that can only fail.
 */
interface Capabilities {
  ai: boolean;
  writeBack: boolean;
}

const NONE: Capabilities = { ai: false, writeBack: false };

let probe: Promise<Capabilities> | null = null;

export function useCapabilities(): Capabilities {
  const [caps, setCaps] = useState<Capabilities>(NONE);

  useEffect(() => {
    probe ??= api
      .health()
      .then((h) => ({ ai: Boolean(h.ai), writeBack: Boolean(h.writeBack) }))
      .catch(() => NONE);

    let alive = true;
    void probe.then((v) => {
      if (alive) setCaps(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  return caps;
}

/** Convenience for the pages that only care about the plain-language layer. */
export function useAiEnabled(): boolean {
  return useCapabilities().ai;
}
