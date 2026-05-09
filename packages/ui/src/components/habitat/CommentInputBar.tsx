import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { Send } from 'lucide-react';
import type { Task } from '../../types/index.js';

interface CommentInputBarProps {
  tasks: Task[];
}

export function CommentInputBar({ tasks }: CommentInputBarProps) {
  const [value, setValue] = useState('');
  const queryClient = useQueryClient();

  const firstTaskId = tasks[0]?.id;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!firstTaskId || !value.trim()) return;
      await api.comments.create(firstTaskId, { content: value.trim() });
    },
    onSuccess: () => {
      if (firstTaskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.list(firstTaskId),
        });
      }
      setValue('');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || !firstTaskId) return;
    mutation.mutate();
  };

  return (
    <div className="p-4 ghost-border-t bg-[var(--surface-container)]/40 flex space-x-3 items-center">
      <div className="flex-1 relative">
        <form onSubmit={handleSubmit} className="flex space-x-3 items-center">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Add a review comment..."
            className="flex-1 bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg px-4 py-2 text-xs focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)]"
          />
          <button
            type="submit"
            disabled={!value.trim() || !firstTaskId || mutation.isPending}
            className="bg-[var(--surface-container-high)] text-[var(--on-surface)] p-2 rounded-lg hover:bg-[var(--surface-container)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed ghost-border"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
