import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth, roleAllows } from '../hooks/useAuth';
import type { Role } from '../types';
import {
  IconOverview,
  IconAlert,
  IconHost,
  IconNetwork,
  IconLatest,
  IconGraph,
  IconMap,
  IconReport,
  IconService,
  IconSite,
  IconSla,
  IconLink,
  IconShield,
  IconChat,
  IconChevron,
} from './icons';

type Item = {
  to: string;
  label: string;
  icon: (p: { size?: number }) => JSX.Element;
  end?: boolean;
  /** Minimum role; omitted means viewer. Mirrors the BFF's ROUTE_RULES. */
  role?: Role;
};
type Section = { title: string; items: Item[] };

// Mirrors Zabbix's native left menu (Monitoring / Reports sections), read-only
// subset, plus the views Zabbix has no equivalent for (Sites, Links).
const SECTIONS: Section[] = [
  {
    title: 'Monitoring',
    items: [
      { to: '/', label: 'Dashboard', icon: IconOverview, end: true },
      { to: '/problems', label: 'Problems', icon: IconAlert },
      { to: '/sites', label: 'Sites', icon: IconSite },
      { to: '/hosts', label: 'Hosts', icon: IconHost },
      { to: '/latest', label: 'Latest data', icon: IconLatest },
      { to: '/graphs', label: 'Graphs', icon: IconGraph },
      { to: '/maps', label: 'Maps', icon: IconMap },
      { to: '/network', label: 'Network', icon: IconNetwork, role: 'operator' },
      { to: '/links', label: 'Links & WAN', icon: IconLink, role: 'operator' },
      { to: '/services', label: 'Services', icon: IconService },
      { to: '/sla', label: 'SLA', icon: IconSla },
    ],
  },
  {
    title: 'Reports',
    items: [
      { to: '/reports/availability', label: 'Availability', icon: IconReport },
      { to: '/reports/capacity', label: 'Capacity', icon: IconGraph },
      { to: '/reports/noise', label: 'Alert noise', icon: IconAlert },
      { to: '/reports/top-triggers', label: 'Top 100 triggers', icon: IconReport },
      { to: '/reports/inventory', label: 'Inventory scorecard', icon: IconShield, role: 'admin' },
    ],
  },
  {
    // The one section with no Zabbix equivalent. Viewer role on purpose: the
    // assistant is only ever shown what a viewer can already see.
    title: 'Assistant',
    items: [{ to: '/assistant', label: 'Ask the assistant', icon: IconChat }],
  },
];

function MenuSection({ section, role }: { section: Section; role: Role | null }) {
  const [open, setOpen] = useState(true);

  // Hide what this role can't reach: the BFF enforces it regardless, but
  // offering a link that can only 403 is worse than not offering it.
  const items = section.items.filter((i) => !i.role || roleAllows(role, i.role));
  if (!items.length) return null;

  return (
    <div className="nav-section">
      <button className="nav-section-title" onClick={() => setOpen((o) => !o)}>
        <span>{section.title}</span>
        <span className={`chev${open ? '' : ' collapsed'}`}>
          <IconChevron />
        </span>
      </button>
      {open && (
        <nav className="nav-items">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { role } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">HC</div>
        <div>
          <div className="title">HCML</div>
          <div className="subtitle">Monitoring Portal</div>
        </div>
      </div>

      <div className="nav-scroll">
        {SECTIONS.map((s) => (
          <MenuSection key={s.title} section={s} role={role} />
        ))}
      </div>

      <div className="spacer" />
      <div className="foot">Read-only · powered by Zabbix API</div>
    </aside>
  );
}
