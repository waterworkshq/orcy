import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlassToaster } from './components/ui/Toast.js';
import { BoardListPage } from './components/habitat/HabitatListPage.js';
import { BoardPage } from './components/habitat/HabitatPage.js';
import { TeamsPage } from './components/habitat/TeamsPage.js';
import { ErrorBoundary } from './components/ui/ErrorBoundary.js';
import { AuthPage } from './components/auth/AuthPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { FeatureDetailPage } from './pages/MissionDetailPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { AppShell } from './components/layout/AppShell.js';
import { useBoardStore } from './store/habitatStore.js';

const DashboardPage = React.lazy(() =>
  import('./pages/DashboardPage.js').then((m) => ({ default: m.DashboardPage }))
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      retry: (failureCount, error: any) => {
        if (error?.status === 429) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function ThemeInitializer() {
  const setTheme = useBoardStore((s) => s.setTheme);
  useEffect(() => {
    document.documentElement.classList.add('dark');
    setTheme('dark');
  }, [setTheme]);
  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('orcy_token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeInitializer />
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<BoardListPage />} />
              <Route path="/boards/:boardId" element={<BoardPage />} />
              <Route path="/dashboard" element={
                <Suspense fallback={
                  <div className="flex items-center justify-center py-20">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                  </div>
                }>
                  <DashboardPage />
                </Suspense>
              } />
              <Route path="/teams" element={<TeamsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/features/:id" element={<FeatureDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </ErrorBoundary>
        <GlassToaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
