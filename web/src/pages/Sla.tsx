import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useAiEnabled } from '../hooks/useAi';
import type { Sla, SlaSli } from '../types';
import { Async, Empty } from '../components/states';
import { SlaExplainPanel } from '../components/ExplainPanel';

/**
 * Zabbix Services → SLA, read-only. Lists the configured SLAs and, for the
 * selected one, how each service is doing against its target this period.
 *
 * Empty until Services and SLAs are defined in Zabbix — the portal reads them,
 * it doesn't create them.
 */

const PERIODS: Record<string, string> = {
  '0': 'Daily',
  '1': 'Weekly',
  '2': 'Monthly',
  '3': 'Quarterly',
  '4': 'Annually',
};

/** Seconds → the coarsest unit that still reads naturally. */
function dur(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const sign = seconds < 0 ? '−' : '';
  if (s < 60) return `${sign}${s}s`;
  if (s < 3600) return `${sign}${Math.round(s / 60)}m`;
  if (s < 86400) return `${sign}${(s / 3600).toFixed(1)}h`;
  return `${sign}${(s / 86400).toFixed(1)}d`;
}

function SliTable({ sla, rows }: { sla: Sla; rows: SlaSli[] }) {
  const target = Number(sla.slo);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Service</th>
            <th>Achieved</th>
            <th>Target</th>
            <th>Uptime</th>
            <th>Downtime</th>
            <th>Error budget left</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const met = r.sli >= target;
            return (
              <tr key={r.serviceid}>
                <td>{r.name}</td>
                <td>
                  <span className={`pill ${met ? 'up' : 'down'}`}>{r.sli.toFixed(4)}%</span>
                </td>
                <td className="muted">{target}%</td>
                <td className="muted">{dur(r.uptime)}</td>
                <td className="muted">{dur(r.downtime)}</td>
                <td className={r.error_budget < 0 ? 'sla-over' : 'muted'}>{dur(r.error_budget)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SlaDetail({ sla, aiEnabled }: { sla: Sla; aiEnabled: boolean }) {
  const q = useAsync<SlaSli[]>(() => api.slaSli(sla.slaid), [sla.slaid], 60_000);
  const [explaining, setExplaining] = useState(false);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{sla.name}</h2>
        {aiEnabled && (
          <button
            className="btn ghost sm"
            onClick={() => setExplaining(true)}
            title="Explain this SLA without the acronyms"
          >
            Plain language
          </button>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {PERIODS[sla.period] ?? 'Period'} · target {sla.slo}%
        {sla.timezone ? ` · ${sla.timezone}` : ''}
        {sla.status === '0' ? ' · disabled' : ''}
      </div>

      <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Reading SLA…">
        {(rows) =>
          rows.length ? (
            <SliTable sla={sla} rows={rows} />
          ) : (
            <Empty>No services are attached to this SLA yet.</Empty>
          )
        }
      </Async>

      {explaining && <SlaExplainPanel sla={sla} onClose={() => setExplaining(false)} />}
    </div>
  );
}

export default function SlaPage() {
  const q = useAsync<Sla[]>(() => api.sla(), [], 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const aiEnabled = useAiEnabled();

  return (
    <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Loading SLAs…">
      {(slas) => {
        if (!slas.length) {
          return (
            <div className="panel">
              <Empty>
                No SLAs are defined in Zabbix yet.
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Create them under <strong>Services → SLA</strong> in Zabbix; this page reads them.
                </div>
              </Empty>
            </div>
          );
        }

        const current = slas.find((s) => s.slaid === selected) ?? slas[0];

        return (
          <div className="grid two-col">
            <div>
              <SlaDetail sla={current} aiEnabled={aiEnabled} />
            </div>

            <div className="panel">
              <h2>SLAs</h2>
              <div className="sla-list">
                {slas.map((s) => (
                  <button
                    key={s.slaid}
                    className={`sla-item${s.slaid === current.slaid ? ' sel' : ''}`}
                    onClick={() => setSelected(s.slaid)}
                  >
                    <span className="name">{s.name}</span>
                    <span className="muted">
                      {PERIODS[s.period] ?? '—'} · {s.slo}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      }}
    </Async>
  );
}
