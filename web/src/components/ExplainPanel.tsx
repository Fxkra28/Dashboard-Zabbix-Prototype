import { useEffect, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Problem, ProblemExplanation, Sla, SlaExplanation } from '../types';
import { Async } from './states';
import { SeverityBadge } from './StatusBadge';
import { fmtTime } from '../lib/severity';

/**
 * The plain-language layer's UI (plan_1.1). A slide-over that translates one
 * Zabbix artifact — a problem's tags and notification wording, or an SLA —
 * for a reader who doesn't speak Zabbix.
 *
 * Nothing here runs until the user clicks "Explain"; the BFF caches each
 * answer, so reopening the same problem costs nothing.
 */

function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escape closes, matching how Zabbix's own overlays behave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">{children}</div>

        <footer className="drawer-foot">
          Written by Claude from the Zabbix data on this page — it rephrases, it doesn’t diagnose.
          Confirm before acting.
        </footer>
      </aside>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="explain-section">
      <h3>{label}</h3>
      {children}
    </section>
  );
}

/** Tags + notification wording for one problem. */
export function ProblemExplainPanel({
  problem,
  onClose,
}: {
  problem: Problem;
  onClose: () => void;
}) {
  const q = useAsync<ProblemExplanation>(() => api.explainProblem(problem.eventid), [
    problem.eventid,
  ]);

  return (
    <Drawer
      title="In plain language"
      subtitle={
        <>
          <SeverityBadge level={problem.severity} />
          <span style={{ marginLeft: 8 }}>{problem.name}</span>
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            {problem.host || 'Unknown host'} · since {fmtTime(problem.clock)}
          </div>
        </>
      }
      onClose={onClose}
    >
      <Async
        loading={q.loading}
        error={q.error}
        data={q.data}
        loadingLabel="Reading the alert…"
      >
        {(x) => (
          <>
            <Section label="What this means">
              <p className="explain-lead">{x.summary}</p>
            </Section>

            <Section label="Who this affects">
              <p>{x.businessImpact}</p>
            </Section>

            <Section label="Suggested next step">
              <p className="explain-action">{x.recommendation}</p>
            </Section>

            {x.tagsExplained.length > 0 && (
              <Section label="What the labels mean">
                <dl className="tag-glossary">
                  {x.tagsExplained.map((t, i) => (
                    <div key={i}>
                      <dt>
                        <span className="tag">
                          {t.tag}
                          {t.value ? `: ${t.value}` : ''}
                        </span>
                      </dt>
                      <dd>{t.meaning}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            )}
          </>
        )}
      </Async>
    </Drawer>
  );
}

/**
 * One SLA's current-period standing. Takes only the fields it renders, so the
 * services tree can open it from a `ServiceSla` without inventing a full `Sla`.
 */
export function SlaExplainPanel({
  sla,
  serviceid,
  onClose,
}: {
  sla: Pick<Sla, 'slaid' | 'name'> & { slo: Sla['slo'] | number };
  serviceid?: string;
  onClose: () => void;
}) {
  const q = useAsync<SlaExplanation>(() => api.explainSla(sla.slaid, serviceid), [
    sla.slaid,
    serviceid,
  ]);

  return (
    <Drawer
      title="In plain language"
      subtitle={
        <>
          {sla.name}
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Target {sla.slo}% availability
          </div>
        </>
      }
      onClose={onClose}
    >
      <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Reading the SLA…">
        {(x) => (
          <>
            <Section label="Where this stands">
              <p className="explain-lead">
                <span className={`pill ${x.meetingTarget ? 'up' : 'down'}`}>{x.status}</span>
              </p>
              <p>{x.plain}</p>
            </Section>

            <Section label="Suggested next step">
              <p className="explain-action">{x.recommendation}</p>
            </Section>
          </>
        )}
      </Async>
    </Drawer>
  );
}
