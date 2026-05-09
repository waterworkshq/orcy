import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import type { Column } from '../../types/index.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';

interface CreateColumnDialogProps {
  boardId: string;
  open: boolean;
  onClose: () => void;
  onAdd: (column: Column) => void;
}

export function CreateColumnDialog({ boardId, open, onClose, onAdd }: CreateColumnDialogProps) {
  const [name, setName] = useState('');
  const [wipLimit, setWipLimit] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      notify.warning('Column name is required');
      return;
    }

    setSaving(true);
    try {
      const result = await api.columns.create(boardId, {
        name: name.trim(),
        wipLimit: wipLimit === '' ? null : Number(wipLimit),
      });
      onAdd(result.column);
      notify.success('Column created');
      onClose();
      setName('');
      setWipLimit('');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Add Column</DialogTitle>
      </DialogHeader>
      <DialogContent>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Column name"
              maxLength={50}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">WIP Limit</label>
            <input
              type="number"
              min="1"
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              placeholder="No limit"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty for no limit</p>
          </div>
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleCreate} loading={saving}>
          Create Column
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
