/**
 * Renderer entry for the connect window (src/connect.html).
 * Separate entry + stylesheet + dictionary, like the exam window and the
 * onboarding wizard, so no window can break another's bundle.
 * The `window.mcConnect` type comes from src/types.d.ts.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectApp } from './connect/ConnectApp';
import './connect/connect.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConnectApp />
  </React.StrictMode>,
);
