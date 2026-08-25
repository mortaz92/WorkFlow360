import React, { useEffect, useState, type ReactNode } from 'react';
import { XIcon } from '../icons';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'default';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  action?: ReactNode;
  duration?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const typeStyles: Record<ToastType, { bg: string; border: string; icon: string; iconColor: string }> = {
  success: { bg: 'bg-success-50', border: 'border-success-200', icon: '✓', iconColor: 'text-success-600' },
  error: { bg: 'bg-danger-50', border: 'border-danger-200', icon: '✕', iconColor: 'text-danger-600' },
  warning: { bg: 'bg-warning-50', border: 'border-warning-200', icon: '⚠', iconColor: 'text-warning-600' },
  info: { bg: 'bg-info-50', border: 'border-info-200', icon: 'ℹ', iconColor: 'text-info-600' },
  default: { bg: 'bg-surface-50', border: 'border-surface-200', icon: '•', iconColor: 'text-surface-600' },
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const { bg, border, icon, iconColor } = typeStyles[toast.type];

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(() => onRemove(toast.id), toast.duration ?? 5000);
      return () => clearTimeout(timer);
    }
  }, [toast, onRemove]);

  return (
    <div
      className={[
        'flex items-start gap-3 rounded-lg border p-4 shadow-lg animate-slide-in',
        bg,
        border,
        'dark:bg-surface-900 dark:border-surface-700',
      ].join(' ')}
      role="alert"
      aria-live="polite"
    >
      <span className={['flex-shrink-0 text-lg font-bold', iconColor].join(' ')} aria-hidden="true">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="m-0 text-sm font-medium text-surface-900 dark:text-surface-100">{toast.title}</p>
        {toast.description && (
          <p className="mt-1 text-sm text-surface-600 dark:text-surface-400">{toast.description}</p>
        )}
        {toast.action && (
          <div className="mt-3">{toast.action}</div>
        )}
      </div>
      <button
        type="button"
        className="flex-shrink-0 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
        onClick={() => onRemove(toast.id)}
        aria-label="Chiudi notifica"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm sm:max-w-md"
      aria-live="polite"
      aria-label="Notifiche"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2, 9);
    const newToast = { ...toast, id };
    setToasts((prev) => [...prev, newToast]);
    return id;
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast deve essere usato all\'interno di ToastProvider');
  }
  return context;
}

// Helper functions per uso rapido
export function useToastHelpers() {
  const { addToast } = useToast();

  return {
    success: (title: string, description?: string, action?: ReactNode) =>
      addToast({ type: 'success', title, description, action }),
    error: (title: string, description?: string, action?: ReactNode) =>
      addToast({ type: 'error', title, description, action }),
    warning: (title: string, description?: string, action?: ReactNode) =>
      addToast({ type: 'warning', title, description, action }),
    info: (title: string, description?: string, action?: ReactNode) =>
      addToast({ type: 'info', title, description, action }),
    default: (title: string, description?: string, action?: ReactNode) =>
      addToast({ type: 'default', title, description, action }),
  };
}

export default ToastProvider;