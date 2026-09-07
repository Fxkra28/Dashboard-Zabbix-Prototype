import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { ZMap, MapDetail, MapSelement } from '../types';
import { Async, Loading } from '../components/states';

const ELEMENT_LABEL: Record<string, string> = {
  '0': 'Host',
  '1': 'Map',
  '2': 'Trigger',
  '3': 'Host group',
  '4': 'Image',
};

// Monitoring → Maps: list Zabbix maps and render the selected map's topology.
export default function Maps() {
  const listQ = useAsync<ZMap[]>(() => api.maps(), []);
  const [mapid, setMapid] = useState('');

  useEffect(() => {
    if (!mapid && listQ.data?.length) setMapid(listQ.data[0].sysmapid);
  }, [listQ.data, mapid]);

  const detailQ = useAsync<MapDetail[]>(
    () => (mapid ? api.mapDetail(mapid) : Promise.resolve([])),
    [mapid],
    30_000,
  );
  const map = detailQ.data?.[0];

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Map</label>
          <select value={mapid} onChange={(e) => setMapid(e.target.value)}>
            {(listQ.data ?? []).map((m) => (
              <option key={m.sysmapid} value={m.sysmapid}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel">
        <Async loading={listQ.loading} error={listQ.error} data={listQ.data} loadingLabel="Loading maps…">
          {(list) =>
            !list.length ? (
              <div className="state">
                No maps defined in Zabbix.
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Create one under Monitoring → Maps in the Zabbix UI; it appears here automatically.
                </div>
              </div>
            ) : detailQ.loading && !map ? (
              <Loading label="Loading topology…" />
            ) : map ? (
              <MapCanvas map={map} />
            ) : (
              <div className="state">Select a map.</div>
            )
          }
        </Async>
      </div>
    </>
  );
}

function MapCanvas({ map }: { map: MapDetail }) {
  const w = Number(map.width) || 800;
  const h = Number(map.height) || 400;
  const byId: Record<string, MapSelement> = {};
  for (const s of map.selements ?? []) byId[s.selementid] = s;

  return (
    <div style={{ overflow: 'auto' }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: '100%', maxWidth: w, border: '1px solid var(--border)', borderRadius: 10, background: '#fbfdff' }}
      >
        {(map.links ?? []).map((l) => {
          const a = byId[l.selementid1];
          const b = byId[l.selementid2];
          if (!a || !b) return null;
          return (
            <line
              key={l.linkid}
              x1={Number(a.x) + 24}
              y1={Number(a.y) + 16}
              x2={Number(b.x) + 24}
              y2={Number(b.y) + 16}
              stroke="#9db4c9"
              strokeWidth={1.5}
            />
          );
        })}
        {(map.selements ?? []).map((s) => (
          <g key={s.selementid} transform={`translate(${Number(s.x)}, ${Number(s.y)})`}>
            <rect width={48} height={32} rx={6} fill="#0067b1" opacity={0.12} stroke="#0067b1" />
            <circle cx={24} cy={16} r={5} fill="#0067b1" />
            <text x={24} y={46} textAnchor="middle" fontSize={11} fill="#1b2733">
              {s.label?.replace(/\{.*?\}/g, '').trim().slice(0, 22) || ELEMENT_LABEL[s.elementtype]}
            </text>
          </g>
        ))}
      </svg>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {map.selements?.length ?? 0} elements · {map.links?.length ?? 0} links · rendered from Zabbix{' '}
        <span className="mono">map.get</span>
      </div>
    </div>
  );
}
