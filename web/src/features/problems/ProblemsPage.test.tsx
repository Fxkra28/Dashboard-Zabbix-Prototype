import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { api } from '../../api';
import { resetAuthProbe } from '../../shared/hooks/useAuth';
import ProblemsTable from './ProblemsTable';
import type { Me, Role } from '../../types';
import { problem } from '../../__tests__/problems';

// The health answer is cached for the life of the module, so the test sets what it reports directly.
const caps = { ai: false, writeBack: true, availabilityMinSeverity: 2, known: true, failed: false, retry: () => undefined };
vi.mock('../assistant/useAi', async (original) => ({ ...(await original<typeof import('../assistant/useAi')>()), useCapabilities: () => caps }));
const { default: Problems } = await import('./Problems');

const as = (role: Role): Me => ({ authEnabled: true, user: { name: 'x', role }, expiresIn: 3600 });

function open(url: string, role: Role = 'operator') {
  window.history.replaceState(null, '', url);
  vi.spyOn(api, 'me').mockResolvedValue(as(role));
  return render(
    <BrowserRouter>
      <Problems />
    </BrowserRouter>,
  );
}
const query = () => new URLSearchParams(window.location.search);
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`\\b${name}\\b`) });

const three = [problem(1, 4, 600), problem(2, 3, 300), problem(3, 2, 60)];

beforeEach(() => {
  resetAuthProbe();
  caps.ai = false;
  caps.writeBack = true;
  caps.known = true;
  vi.spyOn(api, 'problems').mockResolvedValue(three);
  // The Ack dialog asks whether Zabbix is still collecting; here it is.
  vi.spyOn(api, 'freshness').mockResolvedValue({ lastCollectedAt: 1_799_999_960, ageSeconds: 40, stale: false, staleAfterSeconds: 600 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a link to one problem (UX-11)', () => {
  it('marks the row the eventid names, in words as well as by the bar', async () => {
    open('/problems?eventid=2');
    const row = await screen.findByRole('row', { name: /Problem 2/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('sel');
    expect(within(row).getByText(/Linked problem/)).toHaveClass('sr-only');
    expect(rowOf('Problem 1')).not.toHaveAttribute('aria-current');
    expect(rowOf('Problem 3')).not.toHaveClass('sel');
  });

  it('marks nothing when there is no eventid', async () => {
    open('/problems');
    await screen.findByRole('row', { name: /Problem 2/ });
    expect(document.querySelector('tr.sel')).toBeNull();
  });

  it('says so when the problem is no longer in the list', async () => {
    open('/problems?eventid=999');
    expect(await screen.findByText(/That problem is no longer in the list/)).toBeInTheDocument();
    expect(document.querySelector('tr.sel')).toBeNull();
  });

  it('says so when the filters hide it', async () => {
    open('/problems?eventid=3&severity=4');
    expect(await screen.findByText(/hidden by the filters/)).toBeInTheDocument();
  });

  it('shows a problem that sits past the first 100 rows', async () => {
    vi.mocked(api.problems).mockResolvedValue(Array.from({ length: 150 }, (_, i) => problem(i + 1, 3, i)));
    open('/problems?eventid=140');
    const row = await screen.findByRole('row', { name: /Problem 140\b/ });
    expect(row).toHaveAttribute('aria-current', 'true');
  });

  it('opens Acknowledge for an operator, then clears the action and keeps the row marked', async () => {
    open('/problems?eventid=2&action=ack');
    expect(await screen.findByRole('dialog', { name: 'Acknowledge problem' })).toBeInTheDocument();
    expect(query().has('action')).toBe(false);
    expect(query().get('eventid')).toBe('2');
  });

  it('does not open Acknowledge for a viewer, who is not offered it', async () => {
    open('/problems?eventid=2&action=ack', 'viewer');
    await screen.findByRole('row', { name: /Problem 2/ });
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not open Acknowledge on a portal with it off', async () => {
    caps.writeBack = false;
    open('/problems?eventid=2&action=ack');
    await screen.findByRole('row', { name: /Problem 2/ });
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for the server to say what it offers before deciding to open anything', async () => {
    caps.known = false;
    caps.writeBack = false;
    const view = open('/problems?eventid=2&action=ack');
    await screen.findByRole('row', { name: /Problem 2/ });
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(query().get('action')).toBe('ack');

    caps.known = true;
    caps.writeBack = true;
    view.rerender(
      <BrowserRouter>
        <Problems />
      </BrowserRouter>,
    );
    expect(await screen.findByRole('dialog', { name: 'Acknowledge problem' })).toBeInTheDocument();
  });

  it('opens Explain when the portal has it', async () => {
    caps.ai = true;
    vi.spyOn(api, 'explainProblem').mockImplementation(() => new Promise(() => undefined));
    open('/problems?eventid=1&action=explain');
    expect(await screen.findByRole('dialog', { name: 'In plain language' })).toBeInTheDocument();
    expect(api.explainProblem).toHaveBeenCalledWith('1');
  });

  it('scrolls the marked row into view, once', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
    try {
      open('/problems?eventid=2');
      const row = await screen.findByRole('row', { name: /Problem 2/ });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(row);
    } finally {
      // @ts-expect-error jsdom has no scrollIntoView of its own; the page calls it only when there is one
      delete HTMLElement.prototype.scrollIntoView;
    }
  });

  it('does not open Acknowledge for a problem that is already resolved, and still clears the action', async () => {
    vi.mocked(api.problems).mockResolvedValue([three[0], { ...three[1], r_eventid: '77', r_clock: '1800000100' }, three[2]]);
    open('/problems?eventid=2&action=ack');
    await screen.findByRole('row', { name: /Problem 2/ });
    await waitFor(() => expect(query().has('action')).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(query().get('eventid')).toBe('2');
  });

  it('does not open Explain on a portal that does not have it, and still clears the action', async () => {
    caps.ai = false;
    open('/problems?eventid=1&action=explain');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    await waitFor(() => expect(query().has('action')).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for the signed-in role before deciding whether Acknowledge may open', async () => {
    window.history.replaceState(null, '', '/problems?eventid=2&action=ack');
    let answer!: (m: Me) => void;
    vi.spyOn(api, 'me').mockReturnValue(new Promise<Me>((resolve) => (answer = resolve)));
    render(
      <BrowserRouter>
        <Problems />
      </BrowserRouter>,
    );
    await screen.findByRole('row', { name: /Problem 2/ });
    await act(async () => undefined);
    // Not yet known who is asking: neither opened nor thrown away.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(query().get('action')).toBe('ack');

    await act(async () => answer(as('operator')));
    expect(await screen.findByRole('dialog', { name: 'Acknowledge problem' })).toBeInTheDocument();
  });

  it('links each Dashboard row to its problem', () => {
    render(
      <MemoryRouter>
        <ProblemsTable problems={three} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Problem 2' })).toHaveAttribute('href', '/problems?eventid=2');
    expect(screen.getByRole('link', { name: 'host-2' })).toHaveAttribute('href', '/graphs?hostid=10002');
  });
});

describe('acknowledge and close are not instant (UX-13)', () => {
  const ackFirst = async (user: ReturnType<typeof userEvent.setup>, setup?: () => Promise<void>) => {
    await screen.findByRole('row', { name: /Problem 1\b/ });
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await setup?.();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
  };

  it('says the change was sent, and offers no second Ack, until the list shows it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    open('/problems');
    await ackFirst(user);

    // Zabbix has not applied it yet: the refetch still shows the problem as it was.
    const row = rowOf('Problem 1');
    expect(within(row).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Ack' })).toBeNull();
    expect(screen.getByText('Sent to Zabbix. Waiting for it to apply the change.')).toHaveClass('sr-only');
    // The other rows are untouched.
    expect(within(rowOf('Problem 2')).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
    expect(api.acknowledge).toHaveBeenCalledWith({ eventids: ['1'], message: undefined, acknowledge: true, close: false });
  });

  it('reads the list again straight after a send, not at the next poll', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    const before = vi.mocked(api.problems).mock.calls.length;
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Sent, waiting for Zabbix');
    expect(vi.mocked(api.problems).mock.calls.length).toBeGreaterThan(before);
  });

  it('stops saying so, and polls slowly again, once the list shows the acknowledgement', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    open('/problems');
    await ackFirst(user);
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();

    vi.mocked(api.problems).mockResolvedValue([{ ...three[0], acknowledged: '1' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(3_500));
    const row = rowOf('Problem 1');
    expect(within(row).queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(row).getByText('Yes')).toBeInTheDocument();
  });

  it('keeps saying so after a close until the problem reads as resolved, then shows it resolved', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 5 });
    vi.mocked(api.problems).mockResolvedValue([{ ...three[0], manualClose: true }, three[1], three[2]]);
    open('/problems');
    await ackFirst(user, async () => {
      await user.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    });
    expect(api.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ close: true }));
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();

    // Acknowledged but not yet closed is still waiting.
    vi.mocked(api.problems).mockResolvedValue([{ ...three[0], manualClose: true, acknowledged: '1' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(3_500));
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();

    vi.mocked(api.problems).mockResolvedValue([{ ...three[0], acknowledged: '1', r_eventid: '77', r_clock: '1800000100' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(3_500));
    const row = rowOf('Problem 1');
    expect(within(row).queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(row).getByText('Resolved')).toBeInTheDocument();
  });

  it('gives up waiting after a minute and offers Ack again, rather than saying so for ever', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    open('/problems');
    await ackFirst(user);
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(61_000));
    const row = rowOf('Problem 1');
    expect(within(row).queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
  });

  it('keeps waiting a full minute after a second send for the same problem, though the first was applied long ago', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    const unacked = { ...three[0], manualClose: true };
    vi.mocked(api.problems).mockResolvedValue([unacked, three[1], three[2]]);
    open('/problems');
    await ackFirst(user);

    // The list shows the acknowledgement and the row is free again.
    vi.mocked(api.problems).mockResolvedValue([{ ...unacked, acknowledged: '1' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(3_500));
    expect(within(rowOf('Problem 1')).queryByText('Sent, waiting for Zabbix')).toBeNull();

    // At 30 s a close is sent, which Zabbix does not apply.
    await act(async () => void vi.advanceTimersByTime(26_500));
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();

    // 62 s in, the first send's minute is over and this one's is not.
    await act(async () => void vi.advanceTimersByTime(32_000));
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    expect(within(rowOf('Problem 1')).queryByRole('button', { name: 'Ack' })).toBeNull();

    // A minute after the close it gives up, as for any send.
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(within(rowOf('Problem 1')).queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
  });

  it('stops telling a screen reader about it, and reads the list every 30 s again, once the list shows the change', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    open('/problems');
    await ackFirst(user);
    expect(screen.getByText('Sent to Zabbix. Waiting for it to apply the change.')).toBeInTheDocument();

    vi.mocked(api.problems).mockResolvedValue([{ ...three[0], acknowledged: '1' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(3_500));
    expect(screen.queryByText('Sent to Zabbix. Waiting for it to apply the change.')).toBeNull();

    // Nothing is awaited now, so the quick 3 s reading stops: 20 s pass with no request.
    const reads = vi.mocked(api.problems).mock.calls.length;
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(vi.mocked(api.problems).mock.calls.length).toBe(reads);
  });

  it('leaves no timer running once the page is gone', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 6 });
    const view = open('/problems');
    await ackFirst(user);
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for nothing when only a message was sent, since the list cannot show one', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 4 });
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('checkbox', { name: /Acknowledge/ }));
    await user.type(screen.getByRole('textbox', { name: /Message/ }), 'looking into it');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(api.acknowledge).toHaveBeenCalledWith({ eventids: ['1'], message: 'looking into it', acknowledge: false, close: false });
    expect(screen.queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
  });

  it('tells an operator when Acknowledge is off on this portal', async () => {
    caps.writeBack = false;
    open('/problems');
    expect(await screen.findByText(/Acknowledge is off on this portal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ack' })).toBeNull();
  });

  it('tells nobody that before the server has said what it offers', async () => {
    caps.writeBack = false;
    caps.known = false;
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    expect(screen.queryByText(/Acknowledge is off/)).toBeNull();
  });

  it('does not tell a viewer, who could not use it anyway', async () => {
    caps.writeBack = false;
    open('/problems', 'viewer');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    expect(screen.queryByText(/Acknowledge is off/)).toBeNull();
  });

  it('does not tell an operator on a portal that has it on', async () => {
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    expect(screen.queryByText(/Acknowledge is off/)).toBeNull();
  });
});

describe('a close Zabbix has not applied (IN-06)', () => {
  const NOT_APPLIED = 'Close requested, not yet applied by Zabbix';
  const closeFirst = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole('row', { name: /Problem 1\b/ });
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
  };
  const closable = [{ ...three[0], manualClose: true }, three[1], three[2]];

  beforeEach(() => {
    vi.spyOn(api, 'acknowledge').mockResolvedValue({ ok: true, eventids: ['1'], action: 5 });
    vi.mocked(api.problems).mockResolvedValue(closable);
  });

  it('keeps saying so after the minute, instead of the row going back to looking untouched', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open('/problems');
    await closeFirst(user);
    // Within the minute it is still "waiting", as for an acknowledgement.
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    expect(screen.queryByText(NOT_APPLIED)).toBeNull();

    await act(async () => void vi.advanceTimersByTime(61_000));
    const row = rowOf('Problem 1');
    expect(within(row).queryByText('Sent, waiting for Zabbix')).toBeNull();
    expect(within(row).getByText(NOT_APPLIED)).toBeInTheDocument();
    // The close can be asked for again.
    expect(within(row).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
    // Said to a screen reader too, in the status region that said "Sent to Zabbix" before.
    expect(screen.getByText(`${NOT_APPLIED}.`)).toHaveClass('sr-only');
    expect(screen.queryByText('Sent to Zabbix. Waiting for it to apply the change.')).toBeNull();
    // The other rows say nothing.
    expect(within(rowOf('Problem 2')).queryByText(NOT_APPLIED)).toBeNull();

    // Still there a long while later, while the list still shows the problem open.
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(within(rowOf('Problem 1')).getByText(NOT_APPLIED)).toBeInTheDocument();
  });

  it('reads the list every 30 s again, not every 3 s, once it has said so', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open('/problems');
    await closeFirst(user);
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(screen.getByText(NOT_APPLIED)).toBeInTheDocument();
    const reads = vi.mocked(api.problems).mock.calls.length;
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(vi.mocked(api.problems).mock.calls.length).toBe(reads);
    await act(async () => void vi.advanceTimersByTime(12_000));
    expect(vi.mocked(api.problems).mock.calls.length).toBeGreaterThan(reads);
  });

  it('takes the words away once the list shows the problem resolved, however late', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open('/problems');
    await closeFirst(user);
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(screen.getByText(NOT_APPLIED)).toBeInTheDocument();

    vi.mocked(api.problems).mockResolvedValue([{ ...closable[0], acknowledged: '1', r_eventid: '77', r_clock: '1800000100' }, three[1], three[2]]);
    await act(async () => void vi.advanceTimersByTime(31_000));
    const row = rowOf('Problem 1');
    expect(within(row).queryByText(NOT_APPLIED)).toBeNull();
    expect(within(row).getByText('Resolved')).toBeInTheDocument();
    expect(screen.queryByText(`${NOT_APPLIED}.`)).toBeNull();
  });

  it('says "waiting" again, not the late words, when the close is sent a second time', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open('/problems');
    await closeFirst(user);
    await act(async () => void vi.advanceTimersByTime(61_000));
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('checkbox', { name: /Close problem/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const row = rowOf('Problem 1');
    expect(within(row).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    expect(within(row).queryByText(NOT_APPLIED)).toBeNull();
    // And the second minute ends the same way.
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(within(rowOf('Problem 1')).getByText(NOT_APPLIED)).toBeInTheDocument();
  });

  it('says nothing of a close after an acknowledgement alone that the list never showed', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.problems).mockResolvedValue(three);
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    await user.click(within(rowOf('Problem 1')).getByRole('button', { name: 'Ack' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(within(rowOf('Problem 1')).getByText('Sent, waiting for Zabbix')).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(screen.queryByText(NOT_APPLIED)).toBeNull();
    expect(screen.queryByText(`${NOT_APPLIED}.`)).toBeNull();
  });

  it('leaves no timer running once the page is gone, with the words showing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = open('/problems');
    await closeFirst(user);
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(screen.getByText(NOT_APPLIED)).toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the action column header', () => {
  it('has a name for a screen reader instead of an empty cell', async () => {
    open('/problems');
    await screen.findByRole('row', { name: /Problem 1\b/ });
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });
});
