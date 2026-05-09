import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Column as ColumnType } from '../../types/index.js';

interface ColumnSwiperProps {
  columns: ColumnType[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
  children: React.ReactNode;
}

export function ColumnSwiper({ columns, activeIndex, onIndexChange, children }: ColumnSwiperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    isSwiping.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      isSwiping.current = true;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isSwiping.current) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) {
      if (dx < 0 && activeIndex < columns.length - 1) {
        onIndexChange(activeIndex + 1);
      } else if (dx > 0 && activeIndex > 0) {
        onIndexChange(activeIndex - 1);
      }
    }
  }, [activeIndex, columns.length, onIndexChange]);

  const columnNames = columns.slice().sort((a, b) => a.order - b.order).map(c => c.name);

  return (
    <div className="flex flex-1 flex-col min-h-0 md:hidden">
      <div className="flex items-center gap-2 px-2 py-2 border-b bg-background">
        <button
          type="button"
          onClick={() => onIndexChange(Math.max(0, activeIndex - 1))}
          disabled={activeIndex <= 0}
          className="rounded p-1.5 text-muted-foreground disabled:opacity-30 active:bg-accent transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-1 overflow-x-auto no-scrollbar">
          {columnNames.map((name, i) => (
            <button
              key={columns.slice().sort((a, b) => a.order - b.order)[i]?.id}
              type="button"
              onClick={() => onIndexChange(i)}
              className={`rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                i === activeIndex
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onIndexChange(Math.min(columns.length - 1, activeIndex + 1))}
          disabled={activeIndex >= columns.length - 1}
          className="rounded p-1.5 text-muted-foreground disabled:opacity-30 active:bg-accent transition-colors"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
