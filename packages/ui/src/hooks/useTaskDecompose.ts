import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';
import type { Task, SubtaskProposal } from '../types/index.js';

export interface UseTaskDecomposeResult {
  decomposing: boolean;
  decomposeDialogOpen: boolean;
  decompositionProposals: SubtaskProposal[];
  setDecomposeDialogOpen: (v: boolean) => void;
  setDecompositionProposals: (v: SubtaskProposal[]) => void;
  handleDecompose: () => Promise<void>;
  handleDecomposeConfirm: (proposals: SubtaskProposal[]) => Promise<void>;
}

export function useTaskDecompose(task: Task | undefined): UseTaskDecomposeResult {
  const queryClient = useQueryClient();
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeDialogOpen, setDecomposeDialogOpen] = useState(false);
  const [decompositionProposals, setDecompositionProposals] = useState<SubtaskProposal[]>([]);

  async function handleDecompose() {
    if (!task || !task.description.trim()) return;
    setDecomposing(true);
    try {
      const result = await api.tasks.decompose(task.id);
      setDecompositionProposals(result.proposals);
      setDecomposeDialogOpen(true);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setDecomposing(false);
    }
  }

  async function handleDecomposeConfirm(proposals: SubtaskProposal[]) {
    if (!task) return;
    setDecomposeDialogOpen(false);
    let createdCount = 0;
    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      try {
        await api.subtasks.create(task.id, {
          title: proposal.title,
          order: proposal.order,
        });
        createdCount++;
      } catch (e) {
        console.warn(`Failed to create subtask: ${proposal.title}`, e);
      }
    }
    notify.success(`Created ${createdCount} subtasks`);
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
  }

  return { decomposing, decomposeDialogOpen, decompositionProposals, setDecomposeDialogOpen, setDecompositionProposals, handleDecompose, handleDecomposeConfirm };
}
