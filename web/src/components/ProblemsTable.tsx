import type { Problem } from '../types';
import { SeverityBadge } from './StatusBadge';
import { ago } from '../lib/severity';

export default function ProblemsTable({ problems }: { problems: Problem[] }) {
  if (!problems.length) return <div className="state">No open problems.</div>;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Problem</th>
            <th>Host</th>
            <th>Age</th>
            <th>Ack</th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p) => (
            <tr key={p.eventid}>
              <td>
                <SeverityBadge level={p.severity} />
              </td>
              <td>{p.name}</td>
              <td className="muted">{p.host || '—'}</td>
              <td className="muted">{ago(p.clock)}</td>
              <td>
                {p.acknowledged === '1' ? (
                  <span className="pill up">Yes</span>
                ) : (
                  <span className="pill">No</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
