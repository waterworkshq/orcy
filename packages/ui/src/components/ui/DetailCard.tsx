import { Card, CardHeader, CardTitle, CardContent } from './Card.js';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface DetailCardProps {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * Card wrapper with icon + title header.
 * Used by TaskDetailPanel for info sections (Time, Retry Policy, Activity, etc.)
 */
export function DetailCard({ icon: Icon, title, children, className }: DetailCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {children}
      </CardContent>
    </Card>
  );
}