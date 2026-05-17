import React from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { DashboardCharts } from '../components/dashboard/DashboardCharts.js';
import { PredictionSection } from '../components/dashboard/PredictionSection.js';
import { Button } from '../components/ui/Button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { LayoutGrid, ArrowLeft, Loader2 } from 'lucide-react';
import { useDashboardStats, useBoardPredictions, useBoardBurndown } from '../lib/useHabitatData.js';

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = (searchParams.get('period') as '7d' | '30d' | '90d') || '30d';
  const habitatId = searchParams.get('habitatId') || undefined;

  const { data: stats, isLoading: loading, error: statsError } = useDashboardStats();
  const { data: predictions } = useBoardPredictions(habitatId);
  const { data: burndown } = useBoardBurndown(habitatId, period === '7d' ? 7 : period === '90d' ? 90 : 30);

  const error = statsError ? (statsError as Error).message : null;

  const handlePeriodChange = (value: string) => {
    setSearchParams((prev) => {
      prev.set('period', value);
      return prev;
    });
  };

  return (
    <div className="min-h-screen bg-surface">
      <header className="bg-surface-container border-b border-outline-variant/30 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <LayoutGrid className="h-6 w-6 text-primary" />
                <h1 className="text-xl font-bold text-on-surface">Dashboard</h1>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-on-surface-variant">Period:</span>
                <select
                  value={period}
                  onChange={(e) => handlePeriodChange(e.target.value)}
                  className="px-3 py-1.5 border border-outline-variant rounded-md bg-surface-container text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="7d">7 days</option>
                  <option value="30d">30 days</option>
                  <option value="90d">90 days</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-on-surface-variant">Loading dashboard...</span>
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-error">{error}</div>
            </CardContent>
          </Card>
        )}

        {!loading && !error && stats && (
          <DashboardCharts stats={stats} period={period} habitatId={habitatId} />
        )}

        {!loading && !error && predictions && burndown && (
          <div className="mt-8">
            <PredictionSection predictions={predictions} burndown={burndown} />
          </div>
        )}

        {!loading && !error && !stats && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-on-surface-variant">
                No dashboard data available. Start by creating some tasks and having agents work on them.
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
