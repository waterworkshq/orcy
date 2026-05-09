import { Toaster as SonnerToaster } from 'sonner';
import { CheckCircle, XCircle, AlertTriangle, Info, Loader } from 'lucide-react';

const toastClassNames = {
  toast: 'glass-toast',
  title: 'text-sm font-medium font-manrope',
  description: 'text-xs font-manrope opacity-80',
  actionButton: 'glass-toast-action',
  cancelButton: 'glass-toast-action opacity-60',
  closeButton: 'opacity-50 hover:opacity-100 transition-opacity',
  success: 'glass-toast-success',
  error: 'glass-toast-error',
  warning: 'glass-toast-warning',
  info: 'glass-toast-info',
};

export function GlassToaster() {
  return (
    <SonnerToaster
      position="top-right"
      duration={5000}
      closeButton
      richColors={false}
      toastOptions={{
        unstyled: true,
        classNames: toastClassNames,
      }}
      icons={{
        success: <CheckCircle className="w-4 h-4" style={{ color: '#10b981' }} />,
        error: <XCircle className="w-4 h-4" style={{ color: '#ef4444' }} />,
        warning: <AlertTriangle className="w-4 h-4" style={{ color: '#f97316' }} />,
        info: <Info className="w-4 h-4" style={{ color: '#06b6d4' }} />,
        loading: <Loader className="w-4 h-4 animate-spin" style={{ color: 'var(--primary)' }} />,
      }}
    />
  );
}
