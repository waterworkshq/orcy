import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { AlertTriangle, CheckCircle2, Lightbulb, Users, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { formatMinutes } from '../../lib/formatting.js';
import { useBoardCapacity } from '../../lib/useHabitatData.js';
import type { AgentCapacity } from '../../types/index.js';

interface CapacityChartProps {
  habitatId?: string;
}

function getUtilizationColor(utilization: number, overCapacity: boolean): string {
  if (overCapacity) return 'var(--error)';
  if (utilization >= 80) return 'var(--badge-medium)';
  if (utilization >= 50) return 'var(--primary)';
  return 'var(--badge-done)';
}

function UtilizationBar({ data }: { data: AgentCapacity[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No agents registered
      </div>
    );
  }

  const chartData = data.map(agent => ({
    name: agent.agentName.length > 12 ? agent.agentName.slice(0, 12) + '...' : agent.agentName,
    utilization: agent.utilization,
    activeTasks: agent.activeTasks,
    maxTasks: agent.maxTasks,
    overCapacity: agent.overCapacity,
  }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 50 + 40)}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 5, right: 30, left: 80, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-outline-variant/30" />
        <XAxis
          type="number"
          domain={[0, 'dataMax']}
          tick={{ fontSize: 12 }}
          tickFormatter={(v) => `${v}%`}
          className="text-on-surface-variant"
        />
        <YAxis
          dataKey="name"
          type="category"
          tick={{ fontSize: 12 }}
          width={80}
          className="text-on-surface-variant"
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--surface-container)',
            border: '1px solid var(--outline-variant)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--on-surface)',
          }}
          formatter={(value, name) => {
            if (name === 'Utilization') return [`${value}%`, name];
            return [value, name];
          }}
        />
        <ReferenceLine x={100} stroke="var(--error)" strokeDasharray="4 4" label={{ position: 'top', value: '100%', fontSize: 11, fill: 'var(--error)' }} />
        <Bar dataKey="utilization" name="Utilization" radius={[0, 4, 4, 0]}>
          {chartData.map((entry) => (
            <Cell key={entry.name} fill={getUtilizationColor(entry.utilization, entry.overCapacity)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CapacityChart({ habitatId }: CapacityChartProps) {
  const { data: report, isLoading: loading, error: queryError, refetch } = useBoardCapacity(habitatId);
  const error = queryError ? (queryError as Error).message : null;

  if (!habitatId) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-gray-500 dark:text-gray-400">
            Select a board to view agent capacity
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading && !report) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="ml-2 text-gray-500">Loading capacity data...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-red-500">{error}</div>
        </CardContent>
      </Card>
    );
  }

  if (!report) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-card p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-on-surface-variant">Total Capacity</p>
              <p className="text-2xl font-bold text-on-surface mt-1">{report.summary.totalCapacity}</p>
              <p className="text-sm text-on-surface-variant mt-1">Max tasks across agents</p>
            </div>
            <Users className="h-5 w-5 text-primary" />
          </div>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-on-surface-variant">Allocated</p>
              <p className="text-2xl font-bold text-on-surface mt-1">{report.summary.totalAllocated}</p>
              <p className="text-sm text-on-surface-variant mt-1">Active tasks assigned</p>
            </div>
            <Users className="h-5 w-5 text-[var(--agent-orange)]" />
          </div>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-on-surface-variant">Available</p>
              <p className="text-2xl font-bold text-on-surface mt-1">{report.summary.totalAvailable}</p>
              <p className="text-sm text-on-surface-variant mt-1">Open slots remaining</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-[var(--badge-done-text)]" />
          </div>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-on-surface-variant">Utilization</p>
              <p className="text-2xl font-bold text-on-surface mt-1">{report.summary.averageUtilization}%</p>
              <p className="text-sm text-on-surface-variant mt-1">
                {report.summary.overCapacityCount > 0 && (
                  <span className="text-error font-medium">
                    {report.summary.overCapacityCount} over limit
                  </span>
                )}
                {report.summary.overCapacityCount === 0 && 'Across all agents'}
              </p>
            </div>
            {report.summary.overCapacityCount > 0 ? (
              <AlertTriangle className="h-5 w-5 text-error" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-[var(--badge-done-text)]" />
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent Utilization</CardTitle>
        </CardHeader>
        <CardContent>
          <UtilizationBar data={report.agents} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Details</CardTitle>
        </CardHeader>
        <CardContent>
          {report.agents.length === 0 ? (
            <div className="text-center text-on-surface-variant py-8">
              No agents registered. Register agents to see capacity data.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-outline-variant/30">
                    <th className="text-left py-3 px-3 text-on-surface-variant font-medium">Agent</th>
                    <th className="text-left py-3 px-3 text-on-surface-variant font-medium">Domain</th>
                    <th className="text-left py-3 px-3 text-on-surface-variant font-medium">Status</th>
                    <th className="text-right py-3 px-3 text-on-surface-variant font-medium">Active</th>
                    <th className="text-right py-3 px-3 text-on-surface-variant font-medium">Max</th>
                    <th className="text-right py-3 px-3 text-on-surface-variant font-medium">Utilization</th>
                    <th className="text-right py-3 px-3 text-on-surface-variant font-medium">Completed (7d)</th>
                    <th className="text-right py-3 px-3 text-on-surface-variant font-medium">Avg Cycle</th>
                  </tr>
                </thead>
                <tbody>
                  {report.agents.map(agent => (
                    <tr key={agent.agentId} className="border-b border-outline-variant/15">
                      <td className="py-3 px-3 font-medium text-on-surface">
                        {agent.agentName}
                        {agent.overCapacity && (
                          <span className="glass-badge glass-badge-blocked ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium">
                            OVER
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-on-surface-variant">{agent.domain}</td>
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          agent.status === 'working' ? 'glass-badge glass-badge-active' :
                          agent.status === 'idle' ? 'glass-badge glass-badge-done' :
                          'glass-badge glass-badge-low'
                        }`}>
                          {agent.status}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right text-gray-900 dark:text-white">{agent.activeTasks}</td>
                      <td className="py-3 px-3 text-right text-gray-500 dark:text-gray-400">{agent.maxTasks}</td>
                      <td className="py-3 px-3 text-right">
                        <span className={`font-medium ${
                          agent.overCapacity ? 'text-red-600 dark:text-red-400' :
                          agent.utilization >= 80 ? 'text-yellow-600 dark:text-yellow-400' :
                          'text-gray-900 dark:text-white'
                        }`}>
                          {agent.utilization}%
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right text-gray-600 dark:text-gray-300">{agent.completedLast7d}</td>
                      <td className="py-3 px-3 text-right text-gray-600 dark:text-gray-300">{formatMinutes(agent.avgCycleMinutes, { showZeroAs: '-' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {report.suggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="h-5 w-5 text-yellow-500" />
              Suggestions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {report.suggestions.map((suggestion) => (
                <li key={suggestion} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--badge-review)] flex-shrink-0" />
                  {suggestion}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>
    </div>
  );
}
