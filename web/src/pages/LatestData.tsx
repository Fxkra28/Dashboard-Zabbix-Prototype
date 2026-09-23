import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useDebounced } from '../hooks/useDebounced';
import { useUrlState } from '../hooks/useUrlState';
import type { Host, HostGroup, LatestItem, LatestResponse } from '../types';
import { Async } from '../components/states';
import { fmtValue, fmtTime } from '../lib/severity';
import { groupBySite } from '../lib/sites';

const PAGE_SIZE = 100;

// Monitoring → Latest data: pick a host (or group) and see every item's latest value.
// Search (name or key) and paging happen on the BFF, so a host with thousands
// of items is still one quick page. Host, group, search and page live in the
// URL, so Back from a graph returns to the same page of the same list.
export default function LatestData() {
  const hostsQ = useAsync<Host[]>(() => api.hosts(), []);
  const groupsQ = useAsync<HostGroup[]>(() => api.hostgroups(), []);
  const [hostid, setHostid] = useUrlState<string>('hostid', '');
  const [groupid, setGroupid] = useUrlState<string>('groupid', '');
  const [search, setSearch] = useUrlState<string>('q', '', { debounceMs: 300 });
  const [pageParam, setPage] = useUrlState<number>('page', 1);
  const page = Math.max(1, Math.trunc(pageParam));
  const needle = useDebounced(search.trim(), 300);

  const hostGroups = useMemo(
    () => groupBySite(hostsQ.data ?? [], (h) => h.name, (h) => h.site),
    [hostsQ.data],
  );

  useEffect(() => {
    if (!hostid && !groupid && hostGroups.length) setHostid(hostGroups[0].items[0].hostid);
  }, [hostGroups, hostid, groupid, setHostid]);

  // A new search starts at page 1 (a new host or group does, in its onChange).
  // Not on load, which would drop the page the URL asked for.
  const lastNeedle = useRef(needle);
  useEffect(() => {
    if (lastNeedle.current === needle) return;
    lastNeedle.current = needle;
    setPage(1);
  }, [needle, setPage]);

  const q = useAsync<LatestResponse>(
    () =>
      hostid || groupid
        ? api.latest({ hostid, groupid, search: needle, page, pageSize: PAGE_SIZE })
        : Promise.resolve({ items: [], truncated: false, total: 0, page: 1, pageSize: PAGE_SIZE }),
    [hostid, groupid, needle, page],
    20_000,
  );

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? items.length;
  const pageSize = q.data?.pageSize ?? PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(total, page * pageSize);

  const graphable = (i: LatestItem) => (i.value_type === '0' || i.value_type === '3') && i.state !== '1';

  return (
    <>
      <div className="controls">
        <div className="field">
          <label htmlFor="latest-host">Host</label>
          <select
            id="latest-host"
            value={hostid}
            onChange={(e) => {
              setHostid(e.target.value);
              setGroupid('');
              setPage(1);
            }}
          >
            <option value="">— any —</option>
            {hostGroups.map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.items.map((h) => (
                  <option key={h.hostid} value={h.hostid}>
                    {h.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="latest-group">Host group</label>
          <select
            id="latest-group"
            value={groupid}
            onChange={(e) => {
              setGroupid(e.target.value);
              setHostid('');
              setPage(1);
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
          <label htmlFor="latest-search">Search items</label>
          <input
            id="latest-search"
            type="text"
            placeholder="name or key…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">
            {total ? `${first}–${last} of ${total.toLocaleString()}` : '0 items'}
          </span>
        </div>
      </div>

      {q.data?.truncated && (
        <div className="notice warn">
          More than {total.toLocaleString()} items match, so this list is <strong>incomplete</strong>.
          Narrow the search or pick a single host instead of a group.
        </div>
      )}

      <div className="panel">
        <Async
          loading={q.loading}
          error={q.error}
          data={q.data}
          stale={q.stale}
          updatedAt={q.updatedAt}
          loadingLabel="Loading latest data…"
        >
          {() =>
            items.length ? (
              <>
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
                      {items.map((i) => {
                        const changed =
                          i.prevvalue !== undefined && i.prevvalue !== i.lastvalue && graphable(i);
                        return (
                          <tr key={i.itemid}>
                            <td>
                              {i.name}
                              {groupid && i.hosts?.[0] && (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {i.hosts[0].name}
                                </div>
                              )}
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
                                  className="btn ghost sm"
                                  to={`/graphs?hostid=${i.hosts?.[0]?.hostid ?? hostid}&itemid=${i.itemid}`}
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
                {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
              </>
            ) : (
              <div className="state">
                {needle ? `No items match “${needle}”.` : 'No items for this selection.'}
              </div>
            )
          }
        </Async>
      </div>
    </>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  return (
    <div className="pager">
      <button type="button" className="btn ghost sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      <span className="muted">
        Page {page} of {pages}
      </span>
      <button type="button" className="btn ghost sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}
