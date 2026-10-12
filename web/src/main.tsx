import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { reloadOnStaleChunks } from './components/ErrorBoundary';
import { loadCapabilities } from './hooks/useAi';
import './styles.css';

reloadOnStaleChunks();

// Public and cheap: learns the server's time zone before a page labels a time in it (lib/time.ts).
void loadCapabilities();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
