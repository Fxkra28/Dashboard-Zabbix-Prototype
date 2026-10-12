import { Link } from 'react-router-dom';
import type { HostOverview, SiteHost, SiteSource } from '../types';
import { HostStatePill, SeverityCounts } from './StatusBadge';
import { NoData } from './NoData';
import { ifaceType } from '../lib/severity';

/** A host as the Hosts page lists it, or as a site lists its own (which also says where the site came from). */
export type HostTableRow = HostOverview & Partial<Pick<SiteHost, 'availability' | 'siteSource'>>;

/** Where a host's site came from, strongest first. */
const SOURCE_LABEL: Record<SiteSource, string> = {
  tag: 'site tag',
  name: 'from host name',
  inventory: 'inventory',
  group: 'host group (guess)',
};

/** The host table of the Hosts page and of an open site. `siteFrom` adds the "Site from" column. */
export function HostTable({ hosts, siteFrom = false }: { hosts: HostTableRow[]; siteFrom?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Host</th>
            <th>Interface</th>
            <th>Availability</th>
            <th>Status</th>
            <th>Problems</th>
            {siteFrom && <th>Site from</th>}
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => {
            const iface = h.interfaces?.[0];
            return (
              <tr key={h.hostid}>
                <td style={{ fontWeight: 500 }}>{h.name}</td>
                <td className="muted mono">
                  {iface ? `${iface.ip} · ${ifaceType(iface.type)}` : <NoData />}
                </td>
                <td>
                  <HostStatePill host={h} />
                </td>
                <td>
                  {h.maintenance_status === '1' ? (
                    <span className="pill">Maintenance</span>
                  ) : h.status === '0' ? (
                    <span className="pill up">Monitored</span>
                  ) : (
                    <span className="pill">Disabled</span>
                  )}
                </td>
                <td>
                  {h.problems.total > 0 ? (
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <SeverityCounts bySeverity={h.problems.bySeverity} />
                      <span className="muted">({h.problems.total})</span>
                    </span>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
                {siteFrom && (
                  <td>
                    <span className={`site-src ${h.siteSource}`}>
                      {h.siteSource ? (SOURCE_LABEL[h.siteSource] ?? h.siteSource) : null}
                    </span>
                  </td>
                )}
                <td>
                  <Link className="btn ghost sm" to={`/graphs?hostid=${h.hostid}`}>
                    Graphs
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
