import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useAiEnabled } from '../hooks/useAi';
import type { ServiceNode, ServicesResponse } from '../types';
import { SEVERITIES } from '../theme';
import { SeverityBadge } from '../components/StatusBadge';
import { Async, Empty } from '../components/states';
import { SlaExplainPanel } from '../components/ExplainPanel';
import { IconChevron } from '../components/icons';

/**
 * Services tree (plan_1.2 Phase 2, HCML Goal 2) — the portal's answer to
 * "monitoring is still device-centric and reactive".
 *
 * A failure reads as *"BD FPSO — Voice path is degraded, because the agent on
 * FGR-60F-FPSO-01 stopped reporting"*, not as a bare host alert. Zabbix
 * computes the roll-up; this makes it legible.
 */

/** Zabbix service status: -1 is OK, anything else is a propagated severity. */
const statusColor = (status: number) =>
  status < 0 ? 'var(--good)' : (SEVERITIES[status]?.color ?? 'var(--danger)');

function collectDegraded(nodes: ServiceNode[], into: Set<string>): Set<string> {
  for (const n of nodes) {
    if (n.worst >= 0 && n.children.length) into.add(n.serviceid);
    collectDegraded(n.children, into);
  }
  return into;
}

function SlaChip({ sla }: { sla: NonNullable<ServiceNode['sla']> }) {
  return (
    <span className={`svc-sla ${sla.meeting ? 'ok' : 'miss'}`} title={`Target ${sla.slo}%`}>
      {sla.sli.toFixed(2)}% <em>/ {sla.slo}%</em>
    </span>
  );
}

function Row({
  node,
  depth,
  expanded,
  toggle,
  aiEnabled,
  onExplain,
}: {
  node: ServiceNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  aiEnabled: boolean;
  onExplain: (n: ServiceNode) => void;
}) {
  const open = expanded.has(node.serviceid);
  const hasKids = node.children.length > 0;

  return (
    <>
      <div className="svc-row" style={{ paddingLeft: 12 + depth * 22 }}>
        <span className="svc-main">
          {hasKids ? (
            <button
              className={`svc-toggle${open ? '' : ' collapsed'}`}
              onClick={() => toggle(node.serviceid)}
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              <IconChevron />
            </button>
          ) : (
            <span className="svc-toggle placeholder" />
          )}

          <span className="svc-dot" style={{ background: statusColor(node.status) }} />

          <span className="svc-name">{node.name}</span>

          {node.status >= 0 ? (
            <SeverityBadge level={node.status} />
          ) : (
            <span className="pill up">OK</span>
          )}

          {hasKids && (
            <span className="muted svc-count">
              {node.descendants} {node.descendants === 1 ? 'service' : 'services'}
            </span>
          )}
        </span>

        <span className="svc-right">
          {node.sla && <SlaChip sla={node.sla} />}
          {node.sla && aiEnabled && (
            <button
              className="btn ghost sm"
              onClick={() => onExplain(node)}
              title="Explain this SLA without the acronyms"
            >
              Plain language
            </button>
          )}
        </span>
      </div>

      {/* Only leaves show causes — parents would repeat their children's. */}
      {!hasKids &&
        node.problems.map((p) => (
          <div className="svc-cause" style={{ paddingLeft: 12 + depth * 22 + 46 }} key={p.eventid}>
            <span className="svc-cause-label">because</span> {p.name}
          </div>
        ))}

      {open &&
        node.children.map((c) => (
          <Row
            key={c.serviceid}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            aiEnabled={aiEnabled}
            onExplain={onExplain}
          />
        ))}
    </>
  );
}

export default function Services() {
  const q = useAsync<ServicesResponse>(() => api.services(), [], 30_000);
  const aiEnabled = useAiEnabled();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [explaining, setExplaining] = useState<ServiceNode | null>(null);

  // A NOC wants the broken branches already open and the healthy ones folded
  // away. Seed once so the user's own toggling isn't overwritten on re-poll.
  useEffect(() => {
    if (seeded || !q.data) return;
    setExpanded(collectDegraded(q.data.tree, new Set()));
    setSeeded(true);
  }, [q.data, seeded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: ServiceNode[]) => {
      for (const n of nodes) {
        if (n.children.length) ids.add(n.serviceid);
        walk(n.children);
      }
    };
    walk(q.data?.tree ?? []);
    return ids;
  }, [q.data]);

  return (
    <>
      <Async
        loading={q.loading}
        error={q.error}
        data={q.data}
        loadingLabel="Building the service tree…"
      >
        {(data) => {
          if (!data.tree.length) {
            return (
              <div className="panel">
                <Empty>
                  No services are defined in Zabbix yet.
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    Build the tree under <strong>Services</strong> in Zabbix; this page reads it.
                  </div>
                </Empty>
              </div>
            );
          }

          return (
            <>
              <div className="controls">
                <div className="field">
                  <label>&nbsp;</label>
                  <span className="pill">{data.total} services</span>
                </div>
                <div className="field">
                  <label>&nbsp;</label>
                  <span className={`pill ${data.degraded ? 'down' : 'up'}`}>
                    {data.degraded ? `${data.degraded} degraded` : 'All healthy'}
                  </span>
                </div>
                <div className="field">
                  <label>&nbsp;</label>
                  <button
                    className="btn ghost sm"
                    onClick={() =>
                      setExpanded(expanded.size >= allIds.size ? new Set() : new Set(allIds))
                    }
                  >
                    {expanded.size >= allIds.size ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
              </div>

              <div className="panel">
                <div className="svc-tree">
                  {data.tree.map((n) => (
                    <Row
                      key={n.serviceid}
                      node={n}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      aiEnabled={aiEnabled}
                      onExplain={setExplaining}
                    />
                  ))}
                </div>
              </div>
            </>
          );
        }}
      </Async>

      {explaining?.sla && (
        <SlaExplainPanel
          sla={explaining.sla}
          serviceid={explaining.serviceid}
          onClose={() => setExplaining(null)}
        />
      )}
    </>
  );
}
