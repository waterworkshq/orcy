import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card.js';
import { MarkdownContent } from '../ui/MarkdownContent.js';
import { CheckCircle, XCircle } from 'lucide-react';

interface TaskResultCardProps {
  result: string | null;
  rejectionReason: string | null;
  rejectedCount: number;
}

export function TaskResultCard({ result, rejectionReason, rejectedCount }: TaskResultCardProps) {
  return (
    <>
      {result && (
        <Card className="mb-4 border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <CardHeader className="p-3">
            <CardTitle className="flex items-center gap-2 text-sm text-green-800 dark:text-green-200">
              <CheckCircle className="h-4 w-4" />
              Result
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <MarkdownContent content={result} className="text-sm text-green-900 dark:text-green-100 [&_a]:text-green-700 dark:[&_a]:text-green-300" />
          </CardContent>
        </Card>
      )}

      {rejectionReason && (
        <Card className="mb-4 border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardHeader className="p-3">
            <CardTitle className="flex items-center gap-2 text-sm text-red-800 dark:text-red-200">
              <XCircle className="h-4 w-4" />
              Rejection Reason
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <MarkdownContent content={rejectionReason} className="text-sm text-red-900 dark:text-red-100 [&_a]:text-red-700 dark:[&_a]:text-red-300" />
            {rejectedCount > 1 && (
              <span className="ml-2 text-xs"> (rejected {rejectedCount}x)</span>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
