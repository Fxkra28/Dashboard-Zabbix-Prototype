import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { HostOverview } from '../types';
import { AvailabilityPill, SeverityCounts } from '../components/StatusBadge';
import { Async } from '../components/states';
import { hostAvailability, ifaceType } from '../lib/severity';

export default function Hosts() {
  const q = useAsync<HostOverview[]>(() => api.hostsOverview(), [], 30_000);
  const [search, setSearch] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);

  const filtered = useMemo(() => {
    const list = q.data ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter((h) => {
      if (problemsOnly && h.problems.total === 0) return false;
      if (needle && !h.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [q.data, search, problemsOnly]);

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Search host</label>
          <input
            type="text"
            placeholder="host name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Filter</label>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={problemsOnly}
              onChange={(e) => setProblemsOnly(e.target.checked)}
              style={{ minWidth: 'auto', width: 16, height: 16 }}
            />
            With problems only
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">{filtered.length} hosts</span>
        </div>
      </div>

      <div className="panel">
        <Async loading={q.loading} error={q.error} data={q.data}>
          {() => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Interface</th>
                    <th>Availability</th>
                    <th>Status</th>
                    <th>Problems</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((h) => {
                    const av = hostAvailability(h.interfaces);
                    const iface = h.interfaces?.[0];
                    return (
                      <tr key={h.hostid}>
                        <td style={{ fontWeight: 500 }}>{h.name}</td>
                        <td className="muted mono">
                          {iface ? `${iface.ip} · ${ifaceType(iface.type)}` : '—'}
                        </td>
                        <td>
                          <AvailabilityPill kind={av.kind} label={av.label} />
                        </td>
                        <td>
                          {h.maintenance_status === '1' ? (
                            <span className="pill">Maintenance</span>
                          ) : h.status === '0' ? (
                            <span className="pill up">Monitored</span>
                          ) : (
                            <span className="pill">Disabled</span>
                          )}
                        </td>
                        <td>
                          {h.problems.total > 0 ? (
                            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                              <SeverityCounts bySeverity={h.problems.bySeverity} />
                              <span className="muted">({h.problems.total})</span>
                            </span>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td>
                          <Link className="btn ghost" style={{ padding: '4px 12px', fontSize: 12 }} to={`/graphs?hostid=${h.hostid}`}>
                            Graphs
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </div>
    </>
  );
}
