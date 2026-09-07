import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Me, Role } from '../types';

/**
 * Who is signed in, and what may they see (plan_1.2 Phase 7).
 *
 * One shared /api/auth/me probe. With auth disabled the BFF reports role
 * "admin", so the scaffold shows everything and nothing has to special-case
 * the unauthenticated path.
 */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export const roleAllows = (has: Role | null, needs: Role) =>
  has !== null && RANK[has] >= RANK[needs];

let probe: Promise<Me | null> | null = null;

/** Re-probe after login/logout, when the role has changed. */
export function resetAuthProbe(): void {
  probe = null;
}

export function useAuth(): { me: Me | null; role: Role | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    probe ??= api.me().catch(() => null);

    let alive = true;
    void probe.then((v) => {
      if (!alive) return;
      setMe(v);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { me, role: me?.user?.role ?? null, loading };
}
