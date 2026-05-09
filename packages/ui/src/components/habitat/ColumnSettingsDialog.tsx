import React, { useState, useEffect } from 'react';
import {
  DndContext,
  DragEndEvent,
  closestCorners,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import type { Column } from '../../types/index.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { GripVertical } from 'lucide-react';

interface ColumnSettingsDialogProps {
  column: Column;
  open: boolean;
  onClose: () => void;
  onUpdate: (column: Column) => void;
  onDelete: (columnId: string) => void;
  columns: Column[];
}

function SortableColumnItem({ column, isCurrent }: { column: Column; isCurrent: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid={`sortable-column-${column.id}`}
      className={`flex items-center gap-2 rounded border border-outline-variant/30 px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-muted transition-colors ${
        isCurrent ? 'bg-primary/10 border-primary/30' : 'bg-card'
      }`}
    >
      <GripVertical className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <span className="text-sm font-medium truncate">{column.name}</span>
      {isCurrent && (
        <span className="ml-auto text-xs text-primary flex-shrink-0">(selected)</span>
      )}
    </div>
  );
}

function arrayMove<T>(arr: T[], fromIndex: number, toIndex: number): T[] {
  const result = [...arr];
  const [item] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, item);
  return result;
}

export function ColumnSettingsDialog({ column, open, onClose, onUpdate, onDelete, columns }: ColumnSettingsDialogProps) {
  const [name, setName] = useState(column.name);
  const [wipLimit, setWipLimit] = useState(column.wipLimit ?? '');
  const [autoAdvance, setAutoAdvance] = useState(column.autoAdvance);
  const [requiresClaim, setRequiresClaim] = useState(column.requiresClaim);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [orderedColumns, setOrderedColumns] = useState<Column[]>([]);
  const [reordering, setReordering] = useState(false);

  useEffect(() => {
    if (open && columns.length > 0) {
      setOrderedColumns([...columns].sort((a, b) => a.order - b.order));
    }
  }, [open, columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedColumns.findIndex((c) => c.id === active.id);
    const newIndex = orderedColumns.findIndex((c) => c.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(orderedColumns, oldIndex, newIndex);
    setOrderedColumns(reordered);
  }

  function hasOrderChanged(): boolean {
    const sorted = [...columns].sort((a, b) => a.order - b.order);
    if (sorted.length !== orderedColumns.length) return true;
    return sorted.some((c, i) => c.id !== orderedColumns[i].id);
  }

  async function handleSaveOrder() {
    if (!hasOrderChanged()) return;
    setReordering(true);
    const sortedOriginal = [...columns].sort((a, b) => a.order - b.order);
    const newOrdered = orderedColumns.map((c, i) => ({ ...c, order: i }));
    const applied: { id: string; originalOrder: number }[] = [];
    try {
      for (const c of newOrdered) {
        await api.columns.update(c.id, { order: c.order });
        applied.push({ id: c.id, originalOrder: sortedOriginal.find((o) => o.id === c.id)!.order });
      }
      useBoardStore.getState().setColumns(newOrdered);
      notify.success('Column order saved');
    } catch (err) {
      for (const a of applied) {
        await api.columns.update(a.id, { order: a.originalOrder }).catch(() => {});
      }
      notify.error((err as Error).message);
      setOrderedColumns(sortedOriginal);
    } finally {
      setReordering(false);
    }
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await api.columns.update(column.id, {
        name: name.trim() || column.name,
        wipLimit: wipLimit === '' ? null : Number(wipLimit),
        autoAdvance,
        requiresClaim,
      });
      onUpdate(result.column);
      notify.success('Column settings saved');
      onClose();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Column Settings</DialogTitle>
        </DialogHeader>
        <DialogContent>
          <div className="space-y-4">
            {orderedColumns.length > 1 && (
              <div>
                <label className="mb-2 block text-sm font-medium">Column Order</label>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCorners}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={orderedColumns.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                      {orderedColumns.map((c) => (
                        <SortableColumnItem
                          key={c.id}
                          column={c}
                          isCurrent={c.id === column.id}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Drag to reorder columns on the board
                  </p>
                  {hasOrderChanged() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleSaveOrder}
                      loading={reordering}
                    >
                      Save Order
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">WIP Limit</label>
              <input
                type="number"
                min="0"
                value={wipLimit}
                onChange={(e) => setWipLimit(e.target.value)}
                placeholder="No limit"
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">Leave empty for no limit</p>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Auto-advance</label>
                <p className="text-xs text-muted-foreground">Tasks auto-move to next column on approval</p>
              </div>
              <button
                type="button"
                onClick={() => setAutoAdvance(!autoAdvance)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                  autoAdvance ? 'bg-primary' : 'bg-secondary'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    autoAdvance ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Requires Claim</label>
                <p className="text-xs text-muted-foreground">Agents must claim tasks before working</p>
              </div>
              <button
                type="button"
                onClick={() => setRequiresClaim(!requiresClaim)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                  requiresClaim ? 'bg-primary' : 'bg-secondary'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    requiresClaim ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </DialogFooter>
        <div className="mt-6 pt-4 border-t border-destructive/20 px-6 pb-4">
          <h4 className="text-sm font-medium text-destructive mb-2">Danger Zone</h4>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            Delete Column
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onConfirm={async () => {
          setDeleteOpen(false);
          try {
            await api.columns.delete(column.id);
            onDelete(column.id);
            notify.success('Column deleted');
            onClose();
          } catch (err) {
            notify.error((err as Error).message);
          }
        }}
        onCancel={() => setDeleteOpen(false)}
        title="Delete Column"
        description={`Are you sure you want to delete "${column.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
