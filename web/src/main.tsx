import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { connectSSE } from './store.js';

connectSSE();
createRoot(document.getElementById('root')!).render(<App />);
