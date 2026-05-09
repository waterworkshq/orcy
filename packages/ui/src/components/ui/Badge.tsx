import * as React from 'react';
import { clsx } from 'clsx';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'glass-badge inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: '',
        critical: 'glass-badge-critical',
        high: 'glass-badge-high',
        medium: 'glass-badge-medium',
        low: 'glass-badge-low',
        pending: 'glass-badge-low',
        claimed: 'glass-badge-active',
        in_progress: 'glass-badge-active',
        submitted: 'glass-badge-review',
        approved: 'glass-badge-done',
        rejected: 'glass-badge-blocked',
        done: 'glass-badge-done',
        failed: 'glass-badge-blocked',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={clsx(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
