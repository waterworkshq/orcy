import * as React from 'react';
import { clsx } from 'clsx';

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

const positionClasses: Record<string, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1',
};

export const Tooltip = React.forwardRef<HTMLDivElement, TooltipProps>(
  ({ children, content, position = 'top', className }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const tooltipId = React.useId();
    const show = React.useCallback(() => setVisible(true), []);
    const hide = React.useCallback(() => setVisible(false), []);

    return (
      <div
        ref={ref}
        className="relative inline-block"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={visible ? tooltipId : undefined}
      >
        {children}
        {visible && (
          <div
            id={tooltipId}
            role="tooltip"
            className={clsx(
              'absolute z-50 whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-xs text-white shadow-lg',
              positionClasses[position],
              className
            )}
          >
            {content}
          </div>
        )}
      </div>
    );
  }
);

Tooltip.displayName = 'Tooltip';