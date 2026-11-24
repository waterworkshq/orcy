import * as React from 'react';
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_arrIncludes,
  filterFn_equals,
  filterFn_inDateRange,
  filterFn_includesString,
  filterFn_inNumberRange,
  filterFn_weakEquals,
  flexRender,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type OnChangeFn,
  type RowData,
  type RowSelectionState,
  type ReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import { Tooltip } from './Tooltip.js';

const VIRTUALIZE_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 48;

// TanStack Table v9 registers features and their function slots explicitly.
// The registries cover every built-in `auto` can resolve to, so default
// client-side sorting and filtering keep their v8 behavior.
export const DATA_TABLE_FEATURES = tableFeatures({
  columnFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: {
    arrIncludes: filterFn_arrIncludes,
    equals: filterFn_equals,
    inDateRange: filterFn_inDateRange,
    includesString: filterFn_includesString,
    inNumberRange: filterFn_inNumberRange,
    weakEquals: filterFn_weakEquals,
  },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  rowSelectionFeature,
  columnVisibilityFeature,
});

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<typeof DATA_TABLE_FEATURES, TData, unknown>[];
  data: TData[];
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  manualSorting?: boolean;
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange?: OnChangeFn<ColumnVisibilityState>;
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  getRowId?: (row: TData, index: number) => string;
  emptyMessage?: string;
  className?: string;
}

function SortIndicator({ sorted, desc }: { sorted: boolean; desc: boolean }) {
  if (!sorted) {
    return (
      <span className="ml-1 inline-flex flex-col opacity-40">
        <span className="text-[8px] leading-none">▲</span>
        <span className="text-[8px] leading-none">▼</span>
      </span>
    );
  }
  return (
    <Tooltip content={desc ? 'Sort ascending' : 'Sort descending'}>
      <span className="ml-1 inline-flex text-[var(--primary)]">
        {desc ? '▼' : '▲'}
      </span>
    </Tooltip>
  );
}

function ColumnVisibilityDropdown<TData extends RowData>({
  table,
}: {
  table: ReactTable<typeof DATA_TABLE_FEATURES, TData>;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const toggleableColumns = table
    .getAllLeafColumns()
    .filter((c) => c.id !== 'select' && typeof c.getCanHide === 'function' && c.getCanHide());

  if (toggleableColumns.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="rounded px-2 py-1 text-xs text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
        type="button"
      >
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded border border-[var(--outline-variant)] bg-[var(--surface-container)] p-2 shadow-lg">
          {toggleableColumns.map((column) => (
            <label
              key={column.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)]"
            >
              <input
                type="checkbox"
                checked={column.getIsVisible()}
                onChange={column.getToggleVisibilityHandler()}
                className="accent-[var(--primary)]"
              />
              {column.id}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  sorting,
  onSortingChange,
  manualSorting = false,
  enableRowSelection = false,
  rowSelection,
  onRowSelectionChange,
  columnVisibility,
  onColumnVisibilityChange,
  columnFilters,
  onColumnFiltersChange,
  getRowId,
  emptyMessage = 'No data',
  className,
}: DataTableProps<TData>) {
  const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
  const [internalRowSelection, setInternalRowSelection] =
    React.useState<RowSelectionState>({});
  const [internalColumnVisibility, setInternalColumnVisibility] =
    React.useState<ColumnVisibilityState>({});
  const [internalColumnFilters, setInternalColumnFilters] =
    React.useState<ColumnFiltersState>([]);

  const activeSorting = sorting ?? internalSorting;
  const setActiveSorting = onSortingChange ?? setInternalSorting;
  const activeRowSelection = rowSelection ?? internalRowSelection;
  const setActiveRowSelection = onRowSelectionChange ?? setInternalRowSelection;
  const activeColumnVisibility = columnVisibility ?? internalColumnVisibility;
  const setActiveColumnVisibility =
    onColumnVisibilityChange ?? setInternalColumnVisibility;
  const activeColumnFilters = columnFilters ?? internalColumnFilters;
  const setActiveColumnFilters =
    onColumnFiltersChange ?? setInternalColumnFilters;

  const table = useTable({
    features: DATA_TABLE_FEATURES,
    data,
    columns,
    state: {
      sorting: activeSorting,
      rowSelection: activeRowSelection,
      columnVisibility: activeColumnVisibility,
      columnFilters: activeColumnFilters,
    },
    onSortingChange: setActiveSorting,
    onRowSelectionChange: setActiveRowSelection,
    onColumnVisibilityChange: setActiveColumnVisibility,
    onColumnFiltersChange: setActiveColumnFilters,
    manualSorting,
    enableRowSelection,
    getRowId,
  });

  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    enabled: shouldVirtualize,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const paddingBottom = lastVirtualItem
    ? virtualizer.getTotalSize() - lastVirtualItem.end
    : 0;

  return (
    <div className={clsx('flex flex-col', className)}>
      <div className="mb-2 flex justify-end">
        <ColumnVisibilityDropdown table={table} />
      </div>
      <div
        ref={tableContainerRef}
        className="overflow-auto rounded border border-[var(--outline-variant)]"
        style={
          shouldVirtualize ? { maxHeight: '600px', overflowY: 'auto' } : undefined
        }
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={clsx(
                        'border-b border-[var(--outline-variant)] px-3 py-2 text-left text-xs font-medium text-[var(--on-surface-variant)]',
                        canSort && 'cursor-pointer select-none hover:text-[var(--on-surface)]'
                      )}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      {...(canSort
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            onKeyDown: (e: React.KeyboardEvent<HTMLTableCellElement>) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                header.column.getToggleSortingHandler()?.(e);
                              }
                            },
                          }
                        : {})}
                    >
                      <div className="flex items-center">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && (
                          <SortIndicator
                            sorted={sorted !== false}
                            desc={sorted === 'desc'}
                          />
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.getVisibleLeafColumns().length}
                  className="px-3 py-8 text-center text-sm text-[var(--on-surface-variant)]"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : shouldVirtualize ? (
              virtualItems.length > 0 ? (
                <>
                  {paddingTop > 0 && (
                    <tr>
                      <td
                        style={{ height: paddingTop }}
                        colSpan={table.getVisibleLeafColumns().length}
                      />
                    </tr>
                  )}
                  {virtualItems.map((virtualItem) => {
                    const row = rows[virtualItem.index];
                    return (
                      <tr
                        key={row.id}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        className={clsx(
                          'border-b border-[var(--outline-variant)] transition-colors',
                          row.getIsSelected() && 'bg-[var(--primary-container)]/20'
                        )}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            className="px-3 py-2 text-sm text-[var(--on-surface)]"
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr>
                      <td
                        style={{ height: paddingBottom }}
                        colSpan={table.getVisibleLeafColumns().length}
                      />
                    </tr>
                  )}
                </>
              ) : (
                <tr>
                  <td
                    style={{ height: virtualizer.getTotalSize() }}
                    colSpan={table.getVisibleLeafColumns().length}
                  />
                </tr>
              )
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={clsx(
                    'border-b border-[var(--outline-variant)] transition-colors',
                    row.getIsSelected() && 'bg-[var(--primary-container)]/20'
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 text-sm text-[var(--on-surface)]">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export type { DataTableProps, ColumnDef };
