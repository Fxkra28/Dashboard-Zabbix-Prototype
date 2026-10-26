import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api';
import AckDialog from './AckDialog';
import type { Freshness } from '../../types';
import { problem } from '../../__tests__/problems';

/**
 * The warning before a write goes to a Zabbix that has stopped collecting. A stopped zabbix-server
 * leaves every API call working, so a close is accepted and never applied; the dialog says so first.
 */
const fresh: Freshness = { lastCollectedAt: 1_799_999_960, ageSeconds: 40, stale: false, staleAfterSeconds: 600 };
const stopped: Freshness = { lastCollectedAt: 1_799_995_680, ageSeconds: 4_320, stale: true, staleAfterSeconds: 600 };

afterEach(() => vi.restoreAllMocks());

function open(freshness: Promise<Freshness> | Freshness | Error) {
  vi.spyOn(api, 'freshness').mockImplementation(() =>
    freshness instanceof Error ? Promise.reject(freshness) : Promise.resolve(freshness),
  );
  vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<AckDialog problem={problem(1, 4, 600, { manualClose: true })} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}
const warning = () => screen.queryByText(/Zabbix has collected nothing since/);

describe('AckDialog and a Zabbix that has stopped collecting', () => {
  it('says when it last collected and how long ago, before anything is sent', async () => {
    open(stopped);
    expect(await screen.findByText(/Zabbix has collected nothing since .+ \(1 h 12 min ago\)\./)).toBeInTheDocument();
    expect(screen.getByText(/A change you send now may not be applied until it collects again\./)).toBeInTheDocument();
    expect(api.acknowledge).not.toHaveBeenCalled();
  });

  it('is a status the screen reader announces, in the notice style the portal already has', async () => {
    open(stopped);
    const note = await screen.findByRole('status');
    expect(note).toHaveClass('notice', 'warn');
    expect(note).toHaveTextContent('Zabbix has collected nothing since');
  });

  it('warns and does not block: Confirm still sends', async () => {
    const { onDone, onClose } = open(stopped);
    await screen.findByText(/Zabbix has collected nothing since/);
    await userEvent.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ acknowledge: true, close: true }));
    expect(api.acknowledge).toHaveBeenCalledWith({ eventids: ['1'], message: undefined, acknowledge: true, close: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('asks once, when it opens', async () => {
    open(stopped);
    await screen.findByText(/Zabbix has collected nothing since/);
    expect(api.freshness).toHaveBeenCalledTimes(1);
  });

  it('is silent while Zabbix is collecting', async () => {
    open(fresh);
    await waitFor(() => expect(api.freshness).toHaveBeenCalled());
    await screen.findByRole('dialog');
    expect(warning()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is silent when the check fails, and the dialog still works', async () => {
    const { onDone } = open(new Error('Failed to fetch'));
    await waitFor(() => expect(api.freshness).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(warning()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing when the portal cannot tell when Zabbix last collected', async () => {
    open({ lastCollectedAt: null, ageSeconds: null, stale: false, staleAfterSeconds: 600 });
    await waitFor(() => expect(api.freshness).toHaveBeenCalled());
    expect(warning()).toBeNull();
    // Even a stale flag with no time to name is not shown: there is nothing true to say.
    open({ lastCollectedAt: null, ageSeconds: null, stale: true, staleAfterSeconds: 600 });
    await waitFor(() => expect(api.freshness).toHaveBeenCalledTimes(2));
    expect(warning()).toBeNull();
  });

  it('does not touch the page once it is closed before the answer comes', async () => {
    let answer!: (f: Freshness) => void;
    vi.spyOn(api, 'freshness').mockReturnValue(new Promise<Freshness>((resolve) => (answer = resolve)));
    const view = render(<AckDialog problem={problem(1, 4, 600)} onClose={() => undefined} onDone={() => undefined} />);
    view.unmount();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer(stopped);
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('AckDialog and the name on the message', () => {
  it('tells the user their name goes on the message, since the server adds it (SC-08)', async () => {
    open(fresh);
    expect(await screen.findByText(/with your name on the message/)).toBeInTheDocument();
  });
});

describe('AckDialog and a close, which the portal cannot take back', () => {
  it('turns Confirm into the danger button while Close problem is ticked, and back when it is not', async () => {
    open(fresh);
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).not.toHaveClass('danger');
    await userEvent.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    expect(confirm).toHaveClass('btn', 'sm', 'danger');
    await userEvent.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    expect(confirm).not.toHaveClass('danger');
  });
});
