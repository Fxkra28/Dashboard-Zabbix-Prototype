import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import Problems from './pages/Problems';
import Sites from './pages/Sites';
import Hosts from './pages/Hosts';
import HostDetail from './pages/HostDetail';
import LatestData from './pages/LatestData';
import Maps from './pages/Maps';
import Network from './pages/Network';
import Links from './pages/Links';
import Services from './pages/Services';
import Sla from './pages/Sla';
import Availability from './pages/Availability';
import Capacity from './pages/Capacity';
import AlertNoise from './pages/AlertNoise';
import Inventory from './pages/Inventory';
import TopTriggers from './pages/TopTriggers';
import Login from './pages/Login';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/problems" element={<Problems />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/hosts" element={<Hosts />} />
          <Route path="/graphs" element={<HostDetail />} />
          <Route path="/latest" element={<LatestData />} />
          <Route path="/maps" element={<Maps />} />
          <Route path="/network" element={<Network />} />
          <Route path="/links" element={<Links />} />
          <Route path="/services" element={<Services />} />
          <Route path="/sla" element={<Sla />} />
          <Route path="/reports/availability" element={<Availability />} />
          <Route path="/reports/capacity" element={<Capacity />} />
          <Route path="/reports/noise" element={<AlertNoise />} />
          <Route path="/reports/top-triggers" element={<TopTriggers />} />
          <Route path="/reports/inventory" element={<Inventory />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
