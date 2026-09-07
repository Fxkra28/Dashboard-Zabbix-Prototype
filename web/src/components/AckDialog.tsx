import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Problem } from '../types';
import { SeverityBadge } from './StatusBadge';

/**
 * Acknowledge / close write-back (plan_1.2 D8) — the portal's only write.
 *
 * Deliberately explicit: this is the one place a click changes something in
 * Zabbix, so it confirms rather than acting on a single tap, and it never
 * offers Close for a trigger that doesn't allow manual close.
 */
export default function AckDialog({
  problem,
  onClose,
  onDone,
}: {
  problem: Problem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [message, setMessage] = useState('');
  const [acknowledge, setAcknowledge] = useState(problem.acknowledged !== '1');
  const [close, setClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const nothingToDo = !acknowledge && !close && !message.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nothingToDo) return;
    setBusy(true);
    setError('');
    try {
      await api.acknowledge({
        eventids: [problem.eventid],
        message: message.trim() || undefined,
        acknowledge,
        close,
      });
      onDone();
      onClose();
    } catch (err) {
      // Zabbix rejects a close on a trigger without manual_close, among other
      // things — show what it actually said rather than a generic failure.
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={() => !busy && onClose()}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="drawer-head">
          <div>
            <h2>Acknowledge problem</h2>
            <div className="drawer-sub">
              <SeverityBadge level={problem.severity} />
              <span style={{ marginLeft: 8 }}>{problem.name}</span>
              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                {problem.host || 'Unknown host'}
              </div>
            </div>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={2048}
              placeholder="What you found, or what you're doing about it…"
              autoFocus
            />
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
            />
            Acknowledge
            {problem.acknowledged === '1' && (
              <span className="muted"> — already acknowledged</span>
            )}
          </label>

          <label className={`check${problem.manualClose ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={close}
              disabled={!problem.manualClose}
              onChange={(e) => setClose(e.target.checked)}
            />
            Close problem
            {!problem.manualClose && (
              <span className="muted"> — this trigger doesn’t allow manual close</span>
            )}
          </label>

          {error && <div className="login-error">{error}</div>}
        </div>

        <footer className="drawer-foot modal-foot">
          <span className="muted">This writes to Zabbix.</span>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn sm" type="submit" disabled={busy || nothingToDo}>
              {busy ? 'Sending…' : 'Confirm'}
            </button>
          </span>
        </footer>
      </form>
    </div>
  );
}
