import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Demo } from './pages/Demo';
import { Pair } from './pages/Pair';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Demo />} />
        <Route path="/pair/:roomId" element={<Pair />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
