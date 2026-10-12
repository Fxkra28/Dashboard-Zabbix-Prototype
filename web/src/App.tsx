import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import { Loading } from './components/states';

/**
 * Every page is code-split.
 *
 * Importing all of them statically would make one 1.3 MB chunk, so opening the dashboard would
 * download the charting library for the two pages that draw graphs and the report code for pages
 * most viewers never open. Each route fetches its own chunk on first visit.
 *
 * Login is lazy too but sits outside the Layout: it is the one route an unauthenticated visitor
 * reaches, and it should not carry the rest with it.
 */
const Overview = lazy(() => import('./pages/Overview'));
const Problems = lazy(() => import('./pages/Problems'));
const Sites = lazy(() => import('./pages/Sites'));
const Hosts = lazy(() => import('./pages/Hosts'));
const HostDetail = lazy(() => import('./pages/HostDetail'));
const LatestData = lazy(() => import('./pages/LatestData'));
const Maps = lazy(() => import('./pages/Maps'));
const Network = lazy(() => import('./pages/Network'));
const Links = lazy(() => import('./pages/Links'));
const Services = lazy(() => import('./pages/Services'));
const Sla = lazy(() => import('./pages/Sla'));
const Availability = lazy(() => import('./pages/Availability'));
const Capacity = lazy(() => import('./pages/Capacity'));
const AlertNoise = lazy(() => import('./pages/AlertNoise'));
const Inventory = lazy(() => import('./pages/Inventory'));
const TopTriggers = lazy(() => import('./pages/TopTriggers'));
const Assistant = lazy(() => import('./pages/Assistant'));
const Login = lazy(() => import('./pages/Login'));
const NotFound = lazy(() => import('./pages/NotFound'));

/** The route table on its own, so a test can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense fallback={<Loading label="Loading…" />}>
            <Login />
          </Suspense>
        }
      />
      {/* The Suspense boundary lives inside Layout, around <Outlet />, so the
          sidebar and topbar stay painted while a page chunk loads. */}
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
        <Route path="/assistant" element={<Assistant />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
