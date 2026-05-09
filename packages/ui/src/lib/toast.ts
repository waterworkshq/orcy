import { toast } from 'sonner';

const DEFAULT_DURATION = 5000;

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  duration?: number;
  description?: string;
}

function withDefaults(options?: ToastOptions) {
  return {
    duration: options?.duration ?? DEFAULT_DURATION,
    ...(options?.action && { action: options.action }),
    ...(options?.description && { description: options.description }),
  };
}

export const notify = {
  success: (message: string, options?: ToastOptions) =>
    toast.success(message, withDefaults(options)),

  error: (message: string, options?: ToastOptions) =>
    toast.error(message, { ...withDefaults(options), duration: options?.duration ?? 10000 }),

  warning: (message: string, options?: ToastOptions) =>
    toast.warning(message, { ...withDefaults(options), duration: options?.duration ?? 7000 }),

  info: (message: string, options?: ToastOptions) =>
    toast.info(message, withDefaults(options)),

  promise: <T>(p: Promise<T>, msgs: { loading: string; success: string; error: string }) =>
    toast.promise(p, msgs),
};
