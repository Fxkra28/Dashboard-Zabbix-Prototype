import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { api } from '../../api';
import Maps from './Maps';
import type { MapDetail, MapSelement, ZMap } from '../../types';

const maps: ZMap[] = [
  { sysmapid: '1', name: 'Core', width: '800', height: '400' },
  { sysmapid: '2', name: 'Branches', width: '800', height: '400' },
];

const el = (id: string, x: number, name: string, extra: Partial<MapSelement> = {}): MapSelement => ({
  selementid: id,
  label: name,
  labelText: name,
  x: String(x),
  y: '100',
  elementtype: '0',
  hostid: id,
  problems: 0,
  ...extra,
});

const detail = (sysmapid: string, selements: MapSelement[]): MapDetail[] => [
  { ...maps.find((m) => m.sysmapid === sysmapid)!, selements, links: [] },
];

function open(url: string, selements: MapSelement[] = [el('a', 0, 'SW-A')]) {
  window.history.replaceState(null, '', url);
  vi.spyOn(api, 'maps').mockResolvedValue(maps);
  vi.spyOn(api, 'mapDetail').mockImplementation(async (id: string) => detail(id, selements));
  return render(
    <BrowserRouter>
      <Maps />
    </BrowserRouter>,
  );
}
const query = () => new URLSearchParams(window.location.search);
const nameText = (text: string) => screen.getByText(text, { selector: 'text' });

beforeEach(() => window.history.replaceState(null, '', '/maps'));
afterEach(() => vi.restoreAllMocks());

describe('the chosen map is in the URL (FR-18)', () => {
  it('shows the first map when the URL names none, without writing one', async () => {
    open('/maps');
    await waitFor(() => expect(api.mapDetail).toHaveBeenCalledWith('1'));
    expect(screen.getByLabelText('Map')).toHaveValue('1');
    expect(query().has('map')).toBe(false);
  });

  it('shows the map the URL names', async () => {
    open('/maps?map=2');
    await waitFor(() => expect(api.mapDetail).toHaveBeenCalledWith('2'));
    expect(screen.getByLabelText('Map')).toHaveValue('2');
    expect(api.mapDetail).not.toHaveBeenCalledWith('1');
  });

  it('puts a map picked from the list in the URL', async () => {
    const user = userEvent.setup();
    open('/maps');
    await screen.findByRole('option', { name: 'Branches' });
    await user.selectOptions(screen.getByLabelText('Map'), '2');
    expect(query().get('map')).toBe('2');
    await waitFor(() => expect(api.mapDetail).toHaveBeenCalledWith('2'));
  });

  it('reads an id that is not in the list as the first map', async () => {
    open('/maps?map=99');
    await waitFor(() => expect(api.mapDetail).toHaveBeenCalledWith('1'));
    expect(screen.getByLabelText('Map')).toHaveValue('1');
  });
});

describe('map names that would overlap (FR-18)', () => {
  const long = (s: string) => `${s}-LONG-DEVICE-NAME`;

  it('moves a name that would sit on its neighbour, and still draws both', async () => {
    open('/maps', [el('a', 0, long('A')), el('b', 100, long('B'))]);
    const a = await screen.findByText(long('A'), { selector: 'text' });
    const b = nameText(long('B'));
    // The elements are 100 px apart, so at one height the two names would overlap and the second moves. y is relative to the element.
    expect(a.getAttribute('y')).toBe('46');
    expect(b.getAttribute('y')).not.toBe('46');
    expect(screen.queryByText(/left out where crowded/)).toBeNull();
  });

  it('draws a lone name where it always was', async () => {
    open('/maps', [el('a', 0, 'SW-A')]);
    expect((await screen.findByText('SW-A', { selector: 'text' })).getAttribute('y')).toBe('46');
  });

  it('says how many names it left out when the map is too dense, and which, so no one has to point', async () => {
    const crowd = Array.from({ length: 10 }, (_, i) => el(`e${i}`, 100 + i * 4, `HOST-${i}-LONG-DEVICE-NAME`));
    const { container } = open('/maps', crowd);
    const caption = (await screen.findByText(/names? left out where crowded/)).textContent ?? '';
    const drawn = [...container.querySelectorAll('svg g text')].map((t) => t.textContent);
    expect(drawn.length).toBeLessThan(crowd.length);
    const left = crowd.map((e) => e.label).filter((name) => !drawn.includes(name));
    expect(left.length).toBe(crowd.length - drawn.length);
    expect(caption).toContain(`${left.length} names left out where crowded: ${left.join(', ')}`);
    for (const name of drawn) expect(caption).not.toContain(name ?? '');
    expect(caption).not.toMatch(/point at/);
    // Every element still says what it is when pointed at.
    expect([...container.querySelectorAll('svg title')].map((t) => t.textContent)).toEqual(
      crowd.map((e) => expect.stringContaining(e.label)),
    );
  });

  it('names every element for a screen reader, the ones left out of the drawing too', async () => {
    const crowd = Array.from({ length: 10 }, (_, i) =>
      el(`e${i}`, 100 + i * 4, `HOST-${i}-LONG-DEVICE-NAME`, i === 3 ? { problems: 2, maxSeverity: 4 } : {}),
    );
    const { container } = open('/maps', crowd);
    await screen.findByText(/names? left out where crowded/);
    const drawn = [...container.querySelectorAll('svg g text')].map((t) => t.textContent);
    const left = crowd.filter((e) => !drawn.includes(e.label));
    expect(left.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img')).toHaveLength(crowd.length);
    for (const e of left) expect(screen.getByRole('img', { name: new RegExp(`^${e.label}`) })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'HOST-3-LONG-DEVICE-NAME, 2 open problems, worst: High' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'HOST-0-LONG-DEVICE-NAME, no open problems' })).toBeInTheDocument();
  });
});

describe('the caption', () => {
  it('says where the map comes from in plain words, without the API call', async () => {
    open('/maps');
    expect(await screen.findByText(/drawn from the Zabbix map/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('map.get');
  });
});
