import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  icon?: React.ReactNode;
}

export function KPICard({ title, value, subtitle, trend, trendValue, icon }: KPICardProps) {
  const trendIcon = trend === 'up' ? <TrendingUp className="h-4 w-4 text-[var(--badge-done-text)]" /> :
                    trend === 'down' ? <TrendingDown className="h-4 w-4 text-error" /> :
                    <Minus className="h-4 w-4 text-on-surface-variant" />;

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-on-surface-variant">{title}</p>
          <p className="text-2xl font-bold text-on-surface mt-1">{value}</p>
          {subtitle && (
            <p className="text-sm text-on-surface-variant mt-1">{subtitle}</p>
          )}
        </div>
        {icon && <div className="text-on-surface-variant">{icon}</div>}
      </div>
      {trend && trendValue && (
        <div className="flex items-center gap-1 mt-3">
          {trendIcon}
          <span className={`text-sm ${trend === 'up' ? 'text-[var(--badge-done-text)]' : trend === 'down' ? 'text-error' : 'text-on-surface-variant'}`}>
            {trendValue}
          </span>
        </div>
      )}
    </div>
  );
}
