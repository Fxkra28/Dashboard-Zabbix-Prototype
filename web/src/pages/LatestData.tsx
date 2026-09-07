import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Host, HostGroup, LatestItem } from '../types';
import { Async } from '../components/states';
import { fmtValue, fmtTime } from '../lib/severity';

// Monitoring → Latest data: pick a host (or group) and see every item's latest value.
export default function LatestData() {
  const hostsQ = useAsync<Host[]>(() => api.hosts(), []);
  const groupsQ = useAsync<HostGroup[]>(() => api.hostgroups(), []);
  const [hostid, setHostid] = useState('');
  const [groupid, setGroupid] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!hostid && !groupid && hostsQ.data?.length) setHostid(hostsQ.data[0].hostid);
  }, [hostsQ.data, hostid, groupid]);

  const q = useAsync<LatestItem[]>(
    () => (hostid || groupid ? api.latest({ hostid, groupid }) : Promise.resolve([])),
    [hostid, groupid],
    20_000,
  );

  const filtered = useMemo(() => {
    const list = q.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((i) => `${i.name} ${i.key_}`.toLowerCase().includes(needle));
  }, [q.data, search]);

  const graphable = (i: LatestItem) => i.value_type === '0' || i.value_type === '3';

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Host</label>
          <select
            value={hostid}
            onChange={(e) => {
              setHostid(e.target.value);
              setGroupid('');
            }}
          >
            <option value="">— any —</option>
            {(hostsQ.data ?? []).map((h) => (
              <option key={h.hostid} value={h.hostid}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Host group</label>
          <select
            value={groupid}
            onChange={(e) => {
              setGroupid(e.target.value);
              setHostid('');
            }}
          >
            <option value="">— any —</option>
            {(groupsQ.data ?? []).map((g) => (
              <option key={g.groupid} value={g.groupid}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Filter items</label>
          <input
            type="text"
            placeholder="name or key…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">{filtered.length} items</span>
        </div>
      </div>

      <div className="panel">
        <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Loading latest data…">
          {() =>
            filtered.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Key</th>
                      <th>Last check</th>
                      <th>Last value</th>
                      <th>Change</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((i) => {
                      const changed =
                        i.prevvalue !== undefined && i.prevvalue !== i.lastvalue && graphable(i);
                      return (
                        <tr key={i.itemid}>
                          <td>
                            {i.name}
                            {i.state === '1' && (
                              <span className="pill down" style={{ marginLeft: 8 }}>
                                Not supported
                              </span>
                            )}
                          </td>
                          <td className="muted mono">{i.key_}</td>
                          <td className="muted">{fmtTime(i.lastclock)}</td>
                          <td style={{ fontWeight: 500 }}>{fmtValue(i.lastvalue, i.units)}</td>
                          <td className="muted">
                            {changed ? `${fmtValue(i.prevvalue, i.units)} →` : '—'}
                          </td>
                          <td>
                            {graphable(i) && (
                              <Link
                                className="btn ghost"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                to={`/graphs?hostid=${i.hosts?.[0]?.hostid ?? ''}`}
                              >
                                Graph
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="state">No items for this selection.</div>
            )
          }
        </Async>
      </div>
    </>
  );
}
