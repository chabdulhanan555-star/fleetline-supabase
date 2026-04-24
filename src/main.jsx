import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './base.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

const loadingEl = document.getElementById('app-loading');
if (loadingEl) {
  setTimeout(() => {
    loadingEl.style.display = 'none';
  }, 250);
}
