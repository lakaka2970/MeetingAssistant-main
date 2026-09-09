/**
 * Renderer entry for the exam window (src/exam.html).
 * Separate entry + separate stylesheet + separate dictionary, exactly like the
 * onboarding wizard, so neither window can break the other's bundle. The
 * `window.mcExam` type comes from src/types.d.ts, which is where every bridge
 * is declared (a .tsx importing electron/* would cross project boundaries).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExamApp } from './exam/ExamApp';
import './exam/exam.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ExamApp />
  </React.StrictMode>,
);
