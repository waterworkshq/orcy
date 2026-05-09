import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card.js';
import { GitBranch } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import type { PipelineEvent } from '../../types/index.js';

interface TaskPipelineEventsProps {
  pipelineEvents: PipelineEvent[];
}

export function TaskPipelineEvents({ pipelineEvents }: TaskPipelineEventsProps) {
  if (pipelineEvents.length === 0) return null;

  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitBranch className="h-4 w-4" />
          Pipeline ({pipelineEvents.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="space-y-2">
          {pipelineEvents.map((pe) => (
            <div key={pe.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <Badge className={
                pe.status === 'success' ? 'glass-badge-done' :
                pe.status === 'failure' ? 'glass-badge-blocked' :
                pe.status === 'cancelled' ? 'glass-badge-low' :
                pe.status === 'in_progress' ? 'glass-badge-active' :
                'glass-badge-review'
              }>
                {pe.status === 'success' ? 'passed' : pe.status === 'in_progress' ? 'running' : pe.status}
              </Badge>
              <span className="flex-1 truncate text-muted-foreground">{pe.branch}</span>
              <span className="text-xs text-muted-foreground">{pe.provider}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
