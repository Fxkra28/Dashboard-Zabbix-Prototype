import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Host, Item, HistoryPoint } from '../types';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { Async, Loading } from '../components/states';
import { fmtValue } from '../lib/severity';

const HOURS = [1, 6, 24, 72, 168];

export default function HostDetail() {
  const hostsQ = useAsync<Host[]>(() => api.hosts(), []);
  const [params] = useSearchParams();
  const [hostid, setHostid] = useState(params.get('hostid') ?? '');
  const [itemid, setItemid] = useState('');
  const [hours, setHours] = useState(1);

  // default to the first host once loaded
  useEffect(() => {
    if (!hostid && hostsQ.data?.length) setHostid(hostsQ.data[0].hostid);
  }, [hostsQ.data, hostid]);

  const itemsQ = useAsync<Item[]>(() => api.items(hostid), [hostid]);
  // numeric items only (float=0, uint=3) — those we can graph
  const numericItems = useMemo(
    () => (itemsQ.data ?? []).filter((i) => i.value_type === '0' || i.value_type === '3'),
    [itemsQ.data],
  );

  useEffect(() => {
    if (numericItems.length && !numericItems.some((i) => i.itemid === itemid)) {
      setItemid(numericItems[0].itemid);
    }
  }, [numericItems, itemid]);

  const selectedItem = numericItems.find((i) => i.itemid === itemid);
  const valueType = Number(selectedItem?.value_type ?? 0);

  const histQ = useAsync<HistoryPoint[]>(
    () => (itemid ? api.history(itemid, hours, valueType) : Promise.resolve([])),
    [itemid, hours, valueType],
    30_000,
  );

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Host</label>
          <select value={hostid} onChange={(e) => setHostid(e.target.value)}>
            {(hostsQ.data ?? []).map((h) => (
              <option key={h.hostid} value={h.hostid}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Item</label>
          <select
            value={itemid}
            onChange={(e) => setItemid(e.target.value)}
            disabled={!numericItems.length}
          >
            {numericItems.map((i) => (
              <option key={i.itemid} value={i.itemid}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Range</label>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h}h` : `${h / 24}d`}
              </option>
            ))}
          </select>
        </div>
        {selectedItem && (
          <div className="field">
            <label>Latest</label>
            <span className="pill">{fmtValue(selectedItem.lastvalue, selectedItem.units)}</span>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>{selectedItem?.name ?? 'History'}</h2>
        {itemsQ.loading ? (
          <Loading label="Loading items…" />
        ) : !numericItems.length ? (
          <div className="state">This host has no numeric (graphable) items.</div>
        ) : (
          <Async loading={histQ.loading} error={histQ.error} data={histQ.data} loadingLabel="Loading history…">
            {(points) =>
              points.length ? (
                <TimeSeriesChart
                  series={[{ name: selectedItem?.name ?? 'value', points }]}
                  units={selectedItem?.units}
                />
              ) : (
                <div className="state">No history in this range (item may report infrequently).</div>
              )
            }
          </Async>
        )}
      </div>
    </>
  );
}
