import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/charts/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRoutes, Providers } from './App';

async function start() {
  if (import.meta.env.VITE_USE_MOCKS === '1') {
    const { setupWorker } = await import('msw/browser');
    const { handlers } = await import('./mocks/handlers');
    await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' });
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Providers>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </Providers>
    </StrictMode>,
  );
}

void start();
