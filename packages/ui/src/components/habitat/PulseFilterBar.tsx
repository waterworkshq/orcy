import React from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { SignalType } from '../../types/index.js';
import { SIGNAL_TYPES, SIGNAL_LABELS, SIGNAL_COLORS } from '../../lib/signalConfig.js';

interface PulseFilterBarProps {
  activeTypes: SignalType[];
  onToggleType: (type: SignalType) => void;
  hideAuto: boolean;
  onToggleHideAuto: () => void;
  resultCount: number;
  onClearAll: () => void;
}

export function PulseFilterBar({
  activeTypes,
  onToggleType,
  hideAuto,
  onToggleHideAuto,
  resultCount,
  onClearAll,
}: PulseFilterBarProps) {
  const hasFilters = activeTypes.length > 0 || hideAuto;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--outline-variant)] bg-[var(--surface-container)]/30 flex-wrap">
      <div className="flex items-center gap-1 flex-wrap flex-1">
        {SIGNAL_TYPES.map((type) => {
          const isActive = activeTypes.includes(type);
          return (
            <button
              key={type}
              onClick={() => onToggleType(type)}
              className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider transition-all ${
                isActive
                  ? 'ring-1'
                  : 'bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] opacity-50 hover:opacity-80'
              }`}
              style={isActive ? {
                backgroundColor: `color-mix(in srgb, ${SIGNAL_COLORS[type]} 15%, transparent)`,
                color: SIGNAL_COLORS[type],
                borderColor: SIGNAL_COLORS[type],
              } : undefined}
            >
              {SIGNAL_LABELS[type]}
            </button>
          );
        })}

        <button
          onClick={onToggleHideAuto}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider transition-all ${
            hideAuto
              ? 'bg-[var(--surface-container-high)] text-[var(--on-surface)]'
              : 'bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] opacity-50 hover:opacity-80'
          }`}
        >
          {hideAuto ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          Hide Auto
        </button>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-[var(--on-surface-variant)]">
          {resultCount} {resultCount === 1 ? 'signal' : 'signals'}
        </span>
        {hasFilters && (
          <button
            onClick={onClearAll}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] transition-colors"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
