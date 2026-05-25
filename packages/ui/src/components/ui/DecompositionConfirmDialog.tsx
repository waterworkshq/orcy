import * as React from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './Dialog.js';
import { Button } from './Button.js';
import type { SubtaskProposal } from '../../types/index.js';
import { Trash2, Plus, GripVertical } from 'lucide-react';

interface DecompositionConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  parentTaskTitle: string;
  proposals: SubtaskProposal[];
  onConfirm: (proposals: SubtaskProposal[]) => void;
  isLoading?: boolean;
}

export function DecompositionConfirmDialog({
  open,
  onClose,
  parentTaskTitle,
  proposals,
  onConfirm,
  isLoading,
}: DecompositionConfirmDialogProps) {
  const [items, setItems] = React.useState<SubtaskProposal[]>([]);

  React.useEffect(() => {
    if (open) {
      setItems(proposals.map(p => ({ ...p })));
    }
  }, [open, proposals]);

  function handleDelete(id: string) {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, deleted: true } : item
    ));
  }

  function handleRestore(id: string) {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, deleted: false } : item
    ));
  }

  function handleEditTitle(id: string, title: string) {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, editedTitle: title } : item
    ));
  }

  function handleAddSubtask() {
    if (items.length >= 20) return;
    const newItem: SubtaskProposal = {
      id: `new-${Date.now()}`,
      title: 'New subtask',
      order: items.length,
    };
    setItems(prev => [...prev, newItem]);
  }

  function handleConfirm() {
    const accepted = items
      .filter(item => !item.deleted && item.title.trim())
      .map((item, index) => ({
        ...item,
        order: index,
        title: item.editedTitle || item.title,
        description: item.editedDescription || item.description,
      }));
    onConfirm(accepted);
  }

  const visibleItems = items.filter(item => !item.deleted);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Confirm Subtasks</DialogTitle>
        <DialogDescription>
          AI proposed {proposals.length} subtasks for "{parentTaskTitle}".
          Edit, delete, or add subtasks before creating them.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 max-h-96 overflow-y-auto space-y-2">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No subtasks to create.
          </p>
        )}
        {items.map((item, _index) => (
          <div
            key={item.id}
            className={`flex items-start gap-2 rounded border p-2 ${
              item.deleted ? 'opacity-50 bg-muted/30' : 'bg-card'
            }`}
          >
            <GripVertical className="h-4 w-4 mt-2 text-muted-foreground flex-shrink-0 cursor-grab" />
            <div className="flex-1 min-w-0">
              {item.deleted ? (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground line-through">
                    {item.editedTitle || item.title}
                  </span>
                  <button
                    onClick={() => handleRestore(item.id)}
                    className="text-xs text-primary hover:underline"
                  >
                    Restore
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={item.editedTitle || item.title}
                    onChange={(e) => handleEditTitle(item.id, e.target.value)}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  {item.editedTitle !== undefined && item.description && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {item.description}
                    </p>
                  )}
                </>
              )}
            </div>
            {!item.deleted && (
              <button
                onClick={() => handleDelete(item.id)}
                className="flex-shrink-0 text-muted-foreground hover:text-destructive p-1"
                title="Delete subtask"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-between items-center">
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddSubtask}
          disabled={items.length >= 20}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Subtask
        </Button>
        <span className="text-xs text-muted-foreground">
          {visibleItems.length} of {items.length} subtasks
        </span>
      </div>
      <DialogFooter className="mt-4">
        <Button variant="ghost" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          variant="default"
          onClick={handleConfirm}
          disabled={isLoading || visibleItems.length === 0}
        >
          {isLoading ? 'Creating...' : `Create ${visibleItems.length} Subtasks`}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
