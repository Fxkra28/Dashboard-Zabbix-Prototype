/**
 * Two pieces of chrome state that outlive a page load: which theme the viewer
 * picked, and whether the sidebar is a rail.
 *
 * Both are UI preference rather than portal data, so localStorage is the right
 * home. It does not contradict the "nothing persists" line in Known gaps, which
 * is about audit trails and saved views, and it needs neither a backend change
 * nor a state library. DESIGN.md section 6.
 *
 * Every access is guarded. Safari in private mode throws on setItem rather than
 * returning, and a portal that cannot render because it could not save a
 * sidebar width is worse than a sidebar that forgets.
 */
import { useCallback, useEffect, useState } from 'react';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable or full; the preference lasts this page only.
  }
};

export type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'hcml.theme';

/**
 * `system` leaves the attribute off, so the stylesheet's
 * `prefers-color-scheme` block decides. Picking a side sets `data-theme`,
 * which outranks it.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = read(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    write(THEME_KEY, next === 'system' ? null : next);
  }, []);

  return [theme, choose];
}

const RAIL_KEY = 'hcml.sidebar.collapsed';

/**
 * Whether the sidebar is a rail. A stored choice always wins. Until there is
 * one, the Dashboard starts collapsed, because that is the route meant to run
 * on a NOC wall and nobody reads nav labels from across a room.
 *
 * The default is decided once, from the route the session landed on, and not
 * again on navigation. Recomputing per route would make the sidebar move under
 * someone who never touched it.
 */
export function useSidebarRail(landingPath: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = read(RAIL_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return landingPath === '/';
  });

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      write(RAIL_KEY, String(!current));
      return !current;
    });
  }, []);

  return [collapsed, toggle];
}
