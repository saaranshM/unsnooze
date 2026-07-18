import React from 'react';
import { createRoot } from 'react-dom/client';
import FeedbackPage from './pages/FeedbackPage.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FeedbackPage />
  </React.StrictMode>,
);
