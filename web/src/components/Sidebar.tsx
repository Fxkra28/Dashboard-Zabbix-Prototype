import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth, roleAllows } from '../hooks/useAuth';
import BrandMark from './BrandMark';
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

function MenuSection({
  section,
  role,
  collapsed,
}: {
  section: Section;
  role: Role | null;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(true);

  // Hide what this role can't reach: the BFF enforces it regardless, but
  // offering a link that can only 403 is worse than not offering it.
  const items = section.items.filter((i) => !i.role || roleAllows(role, i.role));
  if (!items.length) return null;

  // A rail has no room for a section heading, and collapsing a section you
  // cannot see the name of is not a control worth offering.
  const shown = collapsed || open;

  return (
    <div className="nav-section">
      {!collapsed && (
        <button
          className="nav-section-title"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span>{section.title}</span>
          <span className={`chev${open ? '' : ' collapsed'}`}>
            <IconChevron />
          </span>
        </button>
      )}
      {shown && (
        <nav className="nav-items" aria-label={section.title}>
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={collapsed ? label : undefined}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

export default function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { role } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">
        {/* The rail hides the wordmark beside it, so there the image carries the name. */}
        <BrandMark variant={collapsed ? 'mark' : 'lockup'} alt={collapsed ? 'HCML' : ''} />
        {!collapsed && (
          <div>
            <div className="title">HCML</div>
            <div className="subtitle">Monitoring Portal</div>
          </div>
        )}
      </div>

      <div className="nav-scroll">
        {SECTIONS.map((s) => (
          <MenuSection key={s.title} section={s} role={role} collapsed={collapsed} />
        ))}
      </div>

      <div className="spacer" />
      {!collapsed && <div className="foot">Read-only · powered by Zabbix API</div>}

      <button
        type="button"
        className="rail-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
        title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
      >
        <IconChevron />
      </button>
    </aside>
  );
}
