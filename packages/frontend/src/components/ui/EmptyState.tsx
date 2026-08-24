import { type HTMLAttributes, forwardRef, type ReactNode } from 'react';

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ title, description, icon, action, className = '', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          'flex flex-col items-center justify-center text-center py-12 px-4',
          className,
        ].join(' ')}
        {...props}
      >
        {icon && (
          <div className="mb-4 text-surface-300 dark:text-surface-600" aria-hidden="true">
            {icon}
          </div>
        )}
        <h3 className="m-0 text-lg font-semibold text-surface-900 dark:text-surface-100">{title}</h3>
        {description && (
          <p className="mt-2 text-sm text-surface-500 dark:text-surface-400 max-w-xs">{description}</p>
        )}
        {action && (
          <div className="mt-4">{action}</div>
        )}
      </div>
    );
  },
);

EmptyState.displayName = 'EmptyState';

export default EmptyState;