import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './warehouse/warehouse.css';

// A failed save is already shown to the user by mutate(); many confirm buttons
// then let the rejection go. Only those already-shown errors are silenced —
// anything else still reaches the console.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.toasted) e.preventDefault();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
