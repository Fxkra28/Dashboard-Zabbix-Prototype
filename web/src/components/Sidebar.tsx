import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconOverview,
  IconAlert,
  IconHost,
  IconNetwork,
  IconLatest,
  IconGraph,
  IconMap,
  IconReport,
  IconChevron,
} from './icons';

type Item = { to: string; label: string; icon: (p: { size?: number }) => JSX.Element; end?: boolean };
type Section = { title: string; items: Item[] };

// Mirrors Zabbix's native left menu (Monitoring / Reports sections), read-only subset.
const SECTIONS: Section[] = [
  {
    title: 'Monitoring',
    items: [
      { to: '/', label: 'Dashboard', icon: IconOverview, end: true },
      { to: '/problems', label: 'Problems', icon: IconAlert },
      { to: '/hosts', label: 'Hosts', icon: IconHost },
      { to: '/latest', label: 'Latest data', icon: IconLatest },
      { to: '/graphs', label: 'Graphs', icon: IconGraph },
      { to: '/maps', label: 'Maps', icon: IconMap },
      { to: '/network', label: 'Network', icon: IconNetwork },
    ],
  },
  {
    title: 'Reports',
    items: [{ to: '/reports/top-triggers', label: 'Top 100 triggers', icon: IconReport }],
  },
];

function MenuSection({ section }: { section: Section }) {
  const [open, setOpen] = useState(true);
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
          {section.items.map(({ to, label, icon: Icon, end }) => (
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
          <MenuSection key={s.title} section={s} />
        ))}
      </div>

      <div className="spacer" />
      <div className="foot">Read-only · powered by Zabbix API</div>
    </aside>
  );
}
