import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/problems': 'Problems',
  '/hosts': 'Hosts',
  '/graphs': 'Graphs',
  '/latest': 'Latest data',
  '/maps': 'Maps',
  '/network': 'Network',
  '/reports/top-triggers': 'Top 100 triggers',
};

export default function Layout() {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? 'HCML Monitoring Portal';

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="right">
            <span>{new Date().toLocaleDateString()}</span>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
