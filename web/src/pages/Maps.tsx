import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { ZMap, MapDetail, MapSelement } from '../types';
import { Async, Loaded, Loading } from '../components/states';
import { severity } from '../lib/severity';

const ELEMENT_LABEL: Record<string, string> = {
  '0': 'Host',
  '1': 'Map',
  '2': 'Trigger',
  '3': 'Host group',
  '4': 'Image',
};

const OK = 'var(--good)';
const NEUTRAL = 'var(--muted)';

/** Host elements: green when clear, else the colour of their worst open problem. */
function elementColor(s: MapSelement): string {
  if (s.elementtype !== '0') return NEUTRAL;
  if (!s.problems) return OK;
  return severity(s.maxSeverity ?? 0).color;
}

/** "1.1 IDX02FW01 (192.168.239.42)" reads better as a name line and an address line. */
function labelLines(s: MapSelement): string[] {
  const text = s.labelText ?? s.label?.replace(/\{.*?\}/g, '').trim() ?? '';
  const lines = text
    .split('\n')
    .flatMap((line) => {
      const m = line.match(/^(.+?)\s*(\([^()]*\))$/);
      return m ? [m[1], m[2]] : [line];
    })
    .filter(Boolean);
  // An unlabelled image (HCML's hub icons) stays unlabelled, as Zabbix draws it.
  if (lines.length || s.elementtype === '4') return lines;
  return [ELEMENT_LABEL[s.elementtype] ?? ''];
}

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
          <label htmlFor="map-select">Map</label>
          <select id="map-select" value={mapid} onChange={(e) => setMapid(e.target.value)}>
            {(listQ.data ?? []).map((m) => (
              <option key={m.sysmapid} value={m.sysmapid}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel">
        <Async
          loading={listQ.loading}
          error={listQ.error}
          data={listQ.data}
          updatedAt={listQ.updatedAt}
          loadingLabel="Loading maps…"
        >
          {(list) =>
            !list.length ? (
              <div className="state">
                No maps defined in Zabbix.
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Create one under Monitoring → Maps in the Zabbix UI; it appears here automatically.
                </div>
              </div>
            ) : detailQ.error && (!map || detailQ.stale) ? (
              <div className="state">Could not load this map: {detailQ.error}</div>
            ) : detailQ.loading && !map ? (
              <Loading label="Loading topology…" />
            ) : map ? (
              // The previous map stays, dimmed, while another loads; a failed refresh keeps it with a note.
              <Loaded stale={detailQ.stale} error={detailQ.error} updatedAt={detailQ.updatedAt}>
                <MapCanvas map={map} />
              </Loaded>
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

  const hostEls = (map.selements ?? []).filter((s) => s.elementtype === '0');
  const withProblems = hostEls.filter((s) => s.problems).length;

  return (
    <div style={{ overflow: 'auto' }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{
          width: '100%',
          maxWidth: w,
          overflow: 'visible',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface)',
        }}
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
              style={{ stroke: l.color ? `#${l.color}` : 'var(--border-strong)' }}
              strokeOpacity={0.7}
              strokeWidth={1.5}
            />
          );
        })}
        {(map.selements ?? []).map((s) => {
          const color = elementColor(s);
          const lines = labelLines(s);
          const isHost = s.elementtype === '0';
          return (
            <g key={s.selementid} transform={`translate(${Number(s.x)}, ${Number(s.y)})`}>
              <title>
                {lines.join(' ')}
                {isHost
                  ? s.problems
                    ? ` — ${s.problems} open problem${s.problems === 1 ? '' : 's'}, worst: ${severity(s.maxSeverity ?? 0).name}`
                    : ' — no open problems'
                  : ''}
              </title>
              <rect
                width={48}
                height={32}
                rx={6}
                style={{ fill: color, stroke: color }}
                fillOpacity={0.14}
                strokeWidth={s.problems ? 2 : 1}
              />
              <circle cx={24} cy={16} r={5} style={{ fill: color }} />
              {isHost && s.problems ? (
                <g transform="translate(46, 0)">
                  <circle r={8} style={{ fill: color, stroke: 'var(--surface)' }} strokeWidth={1.5} />
                  <text
                    y={3.5}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={700}
                    style={{ fill: 'var(--surface)' }}
                  >
                    {s.problems > 99 ? '99+' : s.problems}
                  </text>
                </g>
              ) : null}
              {lines.slice(0, 2).map((line, i) => (
                <text
                  key={i}
                  x={24}
                  y={46 + i * 12}
                  textAnchor="middle"
                  fontSize={i === 0 ? 11 : 10}
                  style={{ fill: i === 0 ? 'var(--text)' : 'var(--muted)' }}
                >
                  {line.length > 26 ? `${line.slice(0, 25)}…` : line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          {map.selements?.length ?? 0} elements · {map.links?.length ?? 0} links ·{' '}
          {withProblems} of {hostEls.length} hosts with open problems · rendered from Zabbix{' '}
          <span className="mono">map.get</span>
        </span>
        <span>
          <span style={{ color: OK }}>●</span> no problems ·{' '}
          <span style={{ color: severity(2).color }}>●</span> warning ·{' '}
          <span style={{ color: severity(4).color }}>●</span> high ·{' '}
          <span style={{ color: severity(5).color }}>●</span> disaster
        </span>
      </div>
    </div>
  );
}
