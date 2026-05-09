import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card.js';
import { GitPullRequest } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import type { PullRequest } from '../../types/index.js';

interface TaskPullRequestsProps {
  pullRequests: PullRequest[];
}

export function TaskPullRequests({ pullRequests }: TaskPullRequestsProps) {
  if (pullRequests.length === 0) return null;

  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitPullRequest className="h-4 w-4" />
          Pull Requests ({pullRequests.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="space-y-2">
          {pullRequests.map((pr) => (
            <div key={pr.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 font-medium text-primary hover:underline truncate"
              >
                #{pr.prNumber} {pr.prTitle || 'Untitled'}
              </a>
              <Badge className={
                pr.state === 'open' ? 'glass-badge-review' :
                pr.state === 'merged' ? 'glass-badge-done' :
                'glass-badge-blocked'
              }>
                {pr.state}
              </Badge>
              {pr.reviewStatus !== 'pending' && (
                <Badge className={
                  pr.reviewStatus === 'approved' ? 'glass-badge-done' :
                  'glass-badge-review'
                }>
                  {pr.reviewStatus === 'changes_requested' ? 'changes requested' : pr.reviewStatus}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{pr.provider}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
