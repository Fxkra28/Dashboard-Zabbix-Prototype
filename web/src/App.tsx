import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import Problems from './pages/Problems';
import Hosts from './pages/Hosts';
import HostDetail from './pages/HostDetail';
import LatestData from './pages/LatestData';
import Maps from './pages/Maps';
import Network from './pages/Network';
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
          <Route path="/hosts" element={<Hosts />} />
          <Route path="/graphs" element={<HostDetail />} />
          <Route path="/latest" element={<LatestData />} />
          <Route path="/maps" element={<Maps />} />
          <Route path="/network" element={<Network />} />
          <Route path="/reports/top-triggers" element={<TopTriggers />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
