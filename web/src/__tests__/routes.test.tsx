import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppRoutes } from '../App';
import Layout, { titleFor } from '../components/Layout';
import { APP_TITLE, usePageTitle } from '../hooks/usePageTitle';

const Where = () => <output data-testid="where">{useLocation().pathname}</output>;

/** The routes at an address. Nothing answers fetch, so a page that mounts just waits. */
const open = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <AppRoutes />
      <Where />
    </MemoryRouter>,
  );

beforeEach(() => {
  document.title = APP_TITLE;
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an address that is not a page (FR-06)', () => {
  it('says so, with a way home, and stays on the address', async () => {
    open('/no-such-page');
    expect(await screen.findByText(/does not match a page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(screen.getByTestId('where')).toHaveTextContent('/no-such-page');
  });

  it('keeps the sidebar, so the way to a real page stays one click away', async () => {
    open('/no-such-page');
    await screen.findByText(/does not match a page/);
    expect(screen.getByRole('complementary')).toBeInTheDocument();
  });

  it('names the browser tab for it', async () => {
    open('/no-such-page');
    await screen.findByText(/does not match a page/);
    expect(document.title).toBe(`Page not found · ${APP_TITLE}`);
  });
});

describe('the browser tab title (FR-06)', () => {
  it('follows the page, in the portal name', async () => {
    open('/links');
    await screen.findByRole('heading', { level: 1, name: 'Links & WAN health' });
    expect(document.title).toBe(`Links & WAN health · ${APP_TITLE}`);
  });

  it('still finds the page when the address has another case or a trailing slash', async () => {
    open('/Reports/Noise/');
    await screen.findByRole('heading', { level: 1, name: 'Alert noise' });
    expect(document.title).toBe(`Alert noise · ${APP_TITLE}`);
  });

  it('goes back to the plain name when the shell is left', () => {
    const { unmount } = renderHook(() => usePageTitle('Problems'));
    expect(document.title).toBe(`Problems · ${APP_TITLE}`);
    unmount();
    expect(document.title).toBe(APP_TITLE);
  });
});

describe('titleFor', () => {
  it('gives the menu label of each page and null for anything else', () => {
    expect(titleFor('/')).toBe('Dashboard');
    expect(titleFor('/problems')).toBe('Problems');
    expect(titleFor('/reports/top-triggers')).toBe('Top 100 triggers');
    expect(titleFor('/problems/')).toBe('Problems');
    expect(titleFor('/PROBLEMS')).toBe('Problems');
    expect(titleFor('/problem')).toBeNull();
    expect(titleFor('/reports')).toBeNull();
    expect(titleFor('/problems/1')).toBeNull();
  });
});

describe('the date in the topbar (FR-08)', () => {
  it('turns over at midnight on a tab that stays open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 23, 59, 30));
    // A page with nothing in it: only the shell is under test.
    render(
      <MemoryRouter initialEntries={['/links']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="*" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const topbar = screen.getByRole('banner');
    expect(topbar).toHaveTextContent(new Date(2026, 9, 7).toLocaleDateString());

    act(() => void vi.advanceTimersByTime(60_000));
    expect(topbar).toHaveTextContent(new Date(2026, 9, 8).toLocaleDateString());
    expect(topbar).not.toHaveTextContent(new Date(2026, 9, 7).toLocaleDateString());
  });
});
