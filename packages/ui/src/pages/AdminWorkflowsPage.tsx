import { useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/index.js";
import { queryKeys } from "../lib/queryKeys.js";
import { WorkflowMetricsPanel } from "../components/admin/WorkflowMetricsPanel.js";
import { ExperienceMetricsPanel } from "../components/admin/ExperienceMetricsPanel.js";

const TIME_RANGE_OPTIONS = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "All time", value: 0 },
] as const;

/** Admin dashboard page showing workflow health and per-agent experience signal metrics side by side. */
export function AdminWorkflowsPage() {
  const { habitatId } = useParams<{ habitatId: string }>();
  const [days, setDays] = useState<number>(30);

  const { data: userData, isLoading: isUserLoading } = useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
  });
  const isAdmin = userData?.user?.role === "admin";

  if (!habitatId) {
    return (
      <div className="p-6">
        <p className="text-slate-400">No habitat selected.</p>
      </div>
    );
  }

  if (isUserLoading) {
    return (
      <div className="p-6" data-testid="admin-workflows-loading">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen p-6" data-testid="admin-workflows-page">
      <div className="mb-6 flex items-center gap-4">
        <Link
          to={`/habitats/${habitatId}`}
          className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200"
          data-testid="admin-workflows-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to habitat
        </Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-headline text-2xl font-bold" data-testid="admin-workflows-title">
          Workflow &amp; Experience Metrics
        </h1>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          Time range
          <select
            data-testid="time-range-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200"
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-6">
        <WorkflowMetricsPanel habitatId={habitatId} days={days} />
        <ExperienceMetricsPanel habitatId={habitatId} days={days} />
      </div>
    </div>
  );
}
