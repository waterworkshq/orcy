import type { ReactNode, ComponentType } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './Card.js';

interface StatCardProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: ReactNode;
  subtitle: ReactNode;
}

export function StatCard({ icon: Icon, label, value, subtitle }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
