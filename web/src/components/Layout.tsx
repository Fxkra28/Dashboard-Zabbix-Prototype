import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useAuth, resetAuthProbe } from '../hooks/useAuth';
import { clearToken } from '../api';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/problems': 'Problems',
  '/sites': 'Sites',
  '/hosts': 'Hosts',
  '/graphs': 'Graphs',
  '/latest': 'Latest data',
  '/maps': 'Maps',
  '/network': 'Network',
  '/links': 'Links & WAN health',
  '/services': 'Services',
  '/sla': 'SLA',
  '/reports/availability': 'Availability & response',
  '/reports/capacity': 'Capacity trends',
  '/reports/noise': 'Alert noise',
  '/reports/top-triggers': 'Top 100 triggers',
  '/reports/inventory': 'Inventory & ownership scorecard',
};

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { me, role } = useAuth();
  const title = TITLES[pathname] ?? 'HCML Monitoring Portal';

  const signOut = () => {
    clearToken();
    resetAuthProbe();
    navigate('/login');
  };

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="right">
            <span>{new Date().toLocaleDateString()}</span>
            {role && <span className={`role-chip ${role}`}>{role}</span>}
            {me?.authEnabled && (
              <button className="btn ghost sm" onClick={signOut}>
                Sign out
              </button>
            )}
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
