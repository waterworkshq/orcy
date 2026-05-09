import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card.js';
import { Clock, CheckCircle, XCircle, User, Pencil, ArrowRight } from 'lucide-react';
import type { TaskEvent, Agent } from '../../types/index.js';
import { getActorDisplayName } from '../../lib/task-helpers.js';

interface TaskActivityProps {
  events: TaskEvent[];
  agents: Agent[];
}

export function TaskActivity({ events, agents }: TaskActivityProps) {
  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4" />
          Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="space-y-3">
          {events.map((event) => (
            <div key={event.id} className="flex gap-3 text-sm">
              <div className="mt-0.5">
                {event.action === 'approved' && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}
                {event.action === 'rejected' && <XCircle className="h-3.5 w-3.5 text-red-600" />}
                {event.action === 'claimed' && <User className="h-3.5 w-3.5 text-blue-600" />}
                {event.action === 'updated' && <Pencil className="h-3.5 w-3.5 text-purple-600" />}
                {event.action === 'delegated' && <ArrowRight className="h-3.5 w-3.5 text-amber-600" />}
                {!['approved', 'rejected', 'claimed', 'updated', 'delegated'].includes(event.action) && (
                  <div className="h-3.5 w-3.5 rounded-full bg-secondary" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium capitalize">{event.action.replace('_', ' ')}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(event.timestamp).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  by {getActorDisplayName(event, agents)}
                </p>
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
