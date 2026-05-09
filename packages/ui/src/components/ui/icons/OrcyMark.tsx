import React from 'react';

interface OrcyMarkProps {
  className?: string;
  size?: number;
}

export function OrcyMark({ className, size = 20 }: OrcyMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Orcy"
    >
      <path
        d="M10 1C10 1 5 5 3.5 9.5C2.5 12.5 4 16 10 19C16 16 17.5 12.5 16.5 9.5C15 5 10 1 10 1Z"
        fill="currentColor"
        opacity="0.9"
      />
      <ellipse cx="10" cy="12" rx="3.5" ry="2" fill="var(--surface, #0c0e10)" />
    </svg>
  );
}
