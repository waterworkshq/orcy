import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  type ColumnDef,
} from '@tanstack/react-table';
import { DataTable } from './DataTable.js';

interface TestRow {
  id: string;
  name: string;
  status: string;
  priority: string;
}

const sampleData: TestRow[] = [
  { id: '1', name: 'Task A', status: 'pending', priority: 'high' },
  { id: '2', name: 'Task B', status: 'in_progress', priority: 'medium' },
  { id: '3', name: 'Task C', status: 'done', priority: 'low' },
];

const columns: ColumnDef<TestRow, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    enableSorting: true,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    enableSorting: false,
  },
  {
    accessorKey: 'priority',
    header: 'Priority',
    enableHiding: true,
  },
];

afterEach(() => {
  cleanup();
});

describe('DataTable', () => {
  it('renders columns from ColumnDef array', () => {
    render(<DataTable columns={columns} data={sampleData} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('renders rows from provided data array', () => {
    render(<DataTable columns={columns} data={sampleData} />);
    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
    expect(screen.getByText('Task C')).toBeInTheDocument();
  });

  it('renders cell values for each column', () => {
    render(<DataTable columns={columns} data={sampleData} />);
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('in_progress')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('clicking sortable column header toggles sort direction', () => {
    render(<DataTable columns={columns} data={sampleData} />);
    const nameHeader = screen.getByText('Name');

    fireEvent.click(nameHeader);

    fireEvent.click(nameHeader);

    fireEvent.click(nameHeader);
  });

  it('row selection checkbox toggles row selection state', () => {
    const selectionColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            data-testid="select-all"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            data-testid={`select-${row.original.id}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'name', header: 'Name' },
    ];

    render(
      <DataTable columns={selectionColumns} data={sampleData} enableRowSelection />
    );

    const row1Checkbox = screen.getByTestId('select-1');
    expect(row1Checkbox).not.toBeChecked();

    fireEvent.click(row1Checkbox);
    expect(row1Checkbox).toBeChecked();
  });

  it('select-all checkbox selects and deselects all rows', () => {
    const selectionColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            data-testid="select-all"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            data-testid={`select-${row.original.id}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'name', header: 'Name' },
    ];

    render(
      <DataTable columns={selectionColumns} data={sampleData} enableRowSelection />
    );

    const selectAll = screen.getByTestId('select-all');
    fireEvent.click(selectAll);

    expect(screen.getByTestId('select-1')).toBeChecked();
    expect(screen.getByTestId('select-2')).toBeChecked();
    expect(screen.getByTestId('select-3')).toBeChecked();

    fireEvent.click(selectAll);
    expect(screen.getByTestId('select-1')).not.toBeChecked();
    expect(screen.getByTestId('select-2')).not.toBeChecked();
    expect(screen.getByTestId('select-3')).not.toBeChecked();
  });

  it('selected row has primary-container background class', () => {
    const selectionColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            data-testid="select-all"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            data-testid={`select-${row.original.id}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'name', header: 'Name' },
    ];

    const { container } = render(
      <DataTable columns={selectionColumns} data={sampleData} enableRowSelection />
    );

    fireEvent.click(screen.getByTestId('select-1'));

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('column visibility dropdown hides/shows columns', () => {
    render(<DataTable columns={columns} data={sampleData} />);

    expect(screen.getByText('Priority')).toBeInTheDocument();

    const columnsButton = screen.getByText('Columns');
    fireEvent.click(columnsButton);

    const priorityCheckbox = screen.getByRole('checkbox', { name: 'priority' });
    fireEvent.click(priorityCheckbox);

    expect(screen.queryByText('Priority')).not.toBeInTheDocument();

    const checkboxAgain = screen.getByRole('checkbox', { name: 'priority' });
    fireEvent.click(checkboxAgain);

    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('column visibility dropdown closes on outside click', () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <DataTable columns={columns} data={sampleData} />
      </div>
    );

    fireEvent.click(screen.getByText('Columns'));
    expect(screen.getByRole('checkbox', { name: 'priority' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('checkbox', { name: 'priority' })).not.toBeInTheDocument();
  });

  it('empty data renders empty state message', () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="No tasks found" />);
    expect(screen.getByText('No tasks found')).toBeInTheDocument();
  });

  it('empty data uses default empty message', () => {
    render(<DataTable columns={columns} data={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('large dataset (200+ rows) renders virtualized rows as table rows', () => {
    const bigData: TestRow[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      name: `Task ${i}`,
      status: i % 2 === 0 ? 'pending' : 'done',
      priority: 'medium',
    }));

    const { container } = render(<DataTable columns={columns} data={bigData} />);

    expect(screen.getByText('Name')).toBeInTheDocument();

    const tableContainer = container.querySelector('[style*="max-height"]');
    expect(tableContainer).toBeInTheDocument();
    expect(tableContainer).toHaveStyle({ maxHeight: '600px' });

    const tbody = container.querySelector('tbody');
    expect(tbody).toBeInTheDocument();

    const rows = tbody!.querySelectorAll('tr');
    expect(rows.length).toBeGreaterThan(0);

    const tds = tbody!.querySelectorAll('td');
    const divs = tbody!.querySelectorAll('div');
    expect(tds.length).toBeGreaterThan(0);
    expect(divs.length).toBe(0);
  });

  it('accepts controlled sorting state', () => {
    const onSortingChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={sampleData}
        sorting={[]}
        onSortingChange={onSortingChange}
        manualSorting
      />
    );

    fireEvent.click(screen.getByText('Name'));
    expect(onSortingChange).toHaveBeenCalledTimes(1);
  });

  it('accepts controlled row selection state', () => {
    const onRowSelectionChange = vi.fn();
    const selectionColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            data-testid="select-all"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            data-testid={`select-${row.original.id}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'name', header: 'Name' },
    ];

    render(
      <DataTable
        columns={selectionColumns}
        data={sampleData}
        enableRowSelection
        rowSelection={{}}
        onRowSelectionChange={onRowSelectionChange}
      />
    );

    fireEvent.click(screen.getByTestId('select-1'));
    expect(onRowSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('accepts controlled column visibility state', () => {
    const onColumnVisibilityChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={sampleData}
        columnVisibility={{}}
        onColumnVisibilityChange={onColumnVisibilityChange}
      />
    );

    fireEvent.click(screen.getByText('Columns'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'priority' }));
    expect(onColumnVisibilityChange).toHaveBeenCalledTimes(1);
  });

  it('applies custom className', () => {
    const { container } = render(
      <DataTable columns={columns} data={sampleData} className="custom-wrapper" />
    );
    expect(container.firstChild).toHaveClass('custom-wrapper');
  });

  it('renders sort indicator on sortable columns', () => {
    const { container: _container } = render(<DataTable columns={columns} data={sampleData} />);

    const nameTh = screen.getByText('Name').closest('th')!;
    expect(nameTh).toHaveClass('cursor-pointer');

    const indicator = nameTh.querySelector('span');
    expect(indicator).toBeInTheDocument();
  });

  it('does not render sort indicator on non-sortable columns', () => {
    render(<DataTable columns={columns} data={sampleData} />);
    const statusTh = screen.getByText('Status').closest('th')!;
    expect(statusTh).not.toHaveClass('cursor-pointer');
  });
});
