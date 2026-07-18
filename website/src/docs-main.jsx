import React from 'react';
import { createRoot } from 'react-dom/client';
import DocsPage from './pages/DocsPage.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DocsPage />
  </React.StrictMode>,
);
