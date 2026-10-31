import React from 'react';
import { createRoot } from 'react-dom/client';
import DashboardEMT from './DashboardEMT.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DashboardEMT />
  </React.StrictMode>,
);
