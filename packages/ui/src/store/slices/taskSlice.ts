import type { StateCreator } from 'zustand';
import type { Task, TaskComment } from '../../types/index.js';

export interface TaskSlice {
  tasks: Task[];
  comments: Record<string, TaskComment[]>;
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setComments: (taskId: string, comments: TaskComment[]) => void;
  addComment: (comment: TaskComment) => void;
  removeComment: (taskId: string, commentId: string) => void;
}

export const createTaskSlice: StateCreator<TaskSlice, [], [], TaskSlice> = (set) => ({
  tasks: [],
  comments: {},

  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, task],
    })),

  updateTask: (task) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
    })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  setTasks: (tasks) => set({ tasks }),

  setComments: (taskId, comments) =>
    set((state) => ({
      comments: { ...state.comments, [taskId]: comments },
    })),

  addComment: (comment) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [comment.taskId]: [comment, ...(state.comments[comment.taskId] || [])],
      },
    })),

  removeComment: (taskId, commentId) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [taskId]: (state.comments[taskId] || []).filter((c) => c.id !== commentId),
      },
    })),
});
