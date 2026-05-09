import React from 'react';
import { Button } from '../ui/Button.js';
import { Copy, Sparkles } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DecompositionConfirmDialog } from '../ui/DecompositionConfirmDialog.js';
import type { SubtaskProposal } from '../../types/index.js';

interface TaskDangerZoneProps {
  task: {
    title: string;
    description: string;
  };
  decomposing: boolean;
  decomposeDialogOpen: boolean;
  decompositionProposals: SubtaskProposal[];
  deleteDialogOpen: boolean;
  onDecompose: () => void;
  onDecomposeConfirm: (proposals: SubtaskProposal[]) => Promise<void>;
  onDecomposeDialogClose: () => void;
  onClone: () => void;
  onDelete: () => Promise<void>;
  onDeleteDialogOpen: (open: boolean) => void;
}

export function TaskDangerZone({
  task,
  decomposing,
  decomposeDialogOpen,
  decompositionProposals,
  deleteDialogOpen,
  onDecompose,
  onDecomposeConfirm,
  onDecomposeDialogClose,
  onClone,
  onDelete,
  onDeleteDialogOpen,
}: TaskDangerZoneProps) {
  return (
    <>
      {task.description && (
        <div className="mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onDecompose}
            disabled={decomposing || !task.description.trim()}
            className="gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {decomposing ? 'Splitting...' : 'Sonar Split'}
          </Button>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
        <h4 className="mb-2 text-sm font-semibold text-destructive">Danger Zone</h4>
        <p className="mb-3 text-xs text-muted-foreground">
          Clone this task or permanently delete it. Deletion cannot be undone.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClone}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            Clone task
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDeleteDialogOpen(true)}
          >
            Delete task
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        onConfirm={() => {
          onDeleteDialogOpen(false);
          onDelete();
        }}
        onCancel={() => onDeleteDialogOpen(false)}
        title="Delete Task?"
        description="This will permanently remove the task and cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />

      <DecompositionConfirmDialog
        open={decomposeDialogOpen}
        onClose={onDecomposeDialogClose}
        parentTaskTitle={task.title}
        proposals={decompositionProposals}
        onConfirm={onDecomposeConfirm}
        isLoading={decomposing}
      />
    </>
  );
}
