import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import './lib/plausible'; // Initialize Plausible (auto pageviews enabled by default)
import App from './App';
import './index.css';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

Sentry.init({
  dsn: 'https://04c2025d3ea04059cd3f474b55d0a941@glitch.slingshot.fm/5',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],
  // Tracing
  tracesSampleRate: 1.0,
  // Set 'tracePropagationTargets' to control for which URLs distributed tracing should be enabled
  tracePropagationTargets: ['localhost', /^https:\/\/send\.fm\/api/],
  // Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

function ErrorFallback() {
  const navigate = useNavigate();

  return (
    <div className="h-dvh flex items-center justify-center px-6">
      <div className="max-w-main-card w-full">
        <div className="card-glass p-card shadow-card">
          <div className="relative z-10 flex flex-col items-center gap-5">
            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-red-500/20">
              <AlertCircle className="h-5 w-5 text-red-400" />
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <h2 className="text-heading-xs text-content-primary">
                Something went wrong
              </h2>
              <p className="text-paragraph-xs text-content-secondary">
                An unexpected error occurred. Please try again.
              </p>
            </div>
            <Button className="w-full" onClick={() => { navigate('/'); window.location.reload(); }}>
              Return home
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Sentry.ErrorBoundary fallback={<ErrorFallback />} showDialog={false}>
        <App />
      </Sentry.ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);
