import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { NetDevice, NetPort, HistoryPoint } from '../types';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { UpDown } from '../components/StatusBadge';
import { Async, Loading } from '../components/states';
import { fmtValue } from '../lib/severity';

export default function Network() {
  const devicesQ = useAsync<NetDevice[]>(() => api.netDevices(), [], 30_000);
  const [hostid, setHostid] = useState('');
  const [portItemId, setPortItemId] = useState('');

  useEffect(() => {
    if (!hostid && devicesQ.data?.length) setHostid(devicesQ.data[0].hostid);
  }, [devicesQ.data, hostid]);

  const portsQ = useAsync<NetPort[]>(
    () => (hostid ? api.netPorts(hostid) : Promise.resolve([])),
    [hostid],
    15_000,
  );

  const selectedDevice = devicesQ.data?.find((d) => d.hostid === hostid);
  const ports = portsQ.data ?? [];

  // A port item is graphable if it's numeric (in/out bps counters).
  const graphable = useMemo(
    () => ports.filter((p) => p.value_type === '0' || p.value_type === '3'),
    [ports],
  );
  useEffect(() => {
    if (graphable.length && !graphable.some((p) => p.itemid === portItemId)) {
      setPortItemId(graphable[0].itemid);
    }
  }, [graphable, portItemId]);

  const selectedPort = graphable.find((p) => p.itemid === portItemId);
  const trafficQ = useAsync<HistoryPoint[]>(
    () =>
      portItemId
        ? api.history(portItemId, 1, Number(selectedPort?.value_type ?? 3))
        : Promise.resolve([]),
    [portItemId],
    30_000,
  );

  return (
    <>
      <div className="panel" style={{ marginBottom: 18 }}>
        <h2>Network devices</h2>
        <Async
          loading={devicesQ.loading}
          error={devicesQ.error}
          data={devicesQ.data}
          loadingLabel="Loading devices…"
        >
          {(devices) =>
            devices.length ? (
              <div className="device-grid">
                {devices.map((d) => {
                  const up = d.icmp?.up;
                  const cls = up === undefined ? '' : up ? 'up' : 'down';
                  return (
                    <div
                      key={d.hostid}
                      className={`device ${cls}${d.hostid === hostid ? ' sel' : ''}`}
                      onClick={() => setHostid(d.hostid)}
                    >
                      <div className="name">{d.name}</div>
                      <UpDown up={up} />
                      <div className="meta">
                        {d.icmp?.loss !== undefined && <span>loss {fmtValue(d.icmp.loss, '%')}</span>}
                        {d.icmp?.latency !== undefined && (
                          <span>lat {fmtValue(d.icmp.latency * 1000, 'ms')}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="state">
                No network devices found.
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Set <span className="mono">NET_GROUP_IDS</span> on the BFF, and onboard devices in
                  Zabbix (instruct §13.4). Views populate automatically once they report.
                </div>
              </div>
            )
          }
        </Async>
      </div>

      {selectedDevice && (
        <div className="grid" style={{ gridTemplateColumns: '1fr', gap: 18 }}>
          <div className="panel">
            <h2>{selectedDevice.name} — interfaces / ports</h2>
            {portsQ.loading ? (
              <Loading label="Loading ports…" />
            ) : ports.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Key</th>
                      <th>Latest</th>
                      <th>Graph</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ports.map((p) => (
                      <tr key={p.itemid}>
                        <td>{p.name}</td>
                        <td className="mono muted">{p.key_}</td>
                        <td>{fmtValue(p.lastvalue, p.units)}</td>
                        <td>
                          {(p.value_type === '0' || p.value_type === '3') ? (
                            <button
                              className={`btn ghost`}
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setPortItemId(p.itemid)}
                            >
                              {p.itemid === portItemId ? 'Showing' : 'Show'}
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="state">No interface (net.if.*) items on this device yet.</div>
            )}
          </div>

          {selectedPort && (
            <div className="panel">
              <h2>Interface traffic — {selectedPort.name}</h2>
              <Async
                loading={trafficQ.loading}
                error={trafficQ.error}
                data={trafficQ.data}
                loadingLabel="Loading traffic…"
              >
                {(points) =>
                  points.length ? (
                    <TimeSeriesChart
                      series={[{ name: selectedPort.name, points }]}
                      units={selectedPort.units}
                    />
                  ) : (
                    <div className="state">No traffic history in the last hour.</div>
                  )
                }
              </Async>
            </div>
          )}
        </div>
      )}
    </>
  );
}
