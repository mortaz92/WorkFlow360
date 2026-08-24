import { forwardRef, type TextareaHTMLAttributes, useId } from 'react';

export type TextareaSize = 'sm' | 'md' | 'lg';
export type TextareaState = 'default' | 'error' | 'success';

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  state?: TextareaState;
  size?: TextareaSize;
  fullWidth?: boolean;
}

const sizeStyles: Record<TextareaSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-3 py-2.5 text-sm',
  lg: 'px-4 py-3 text-base',
};

const stateStyles: Record<TextareaState, string> = {
  default: 'border-surface-300 focus:border-primary-600 focus:ring-primary-200 dark:border-surface-600 dark:focus:border-primary-400 dark:focus:ring-primary-900/30',
  error: 'border-danger-500 focus:border-danger-500 focus:ring-danger-200 dark:border-danger-400 dark:focus:border-danger-400 dark:focus:ring-danger-900/30',
  success: 'border-success-500 focus:border-success-500 focus:ring-success-200 dark:border-success-400 dark:focus:border-success-400 dark:focus:ring-success-900/30',
};

const baseStyles =
  'w-full rounded-lg border bg-white text-surface-900 placeholder:text-surface-400 transition-all duration-150 ' +
  'focus:outline-none focus:ring-2 focus:ring-offset-0 ' +
  'disabled:bg-surface-100 disabled:text-surface-500 disabled:cursor-not-allowed ' +
  'dark:bg-surface-800 dark:text-surface-100 dark:placeholder:text-surface-500 ' +
  'resize-y min-h-[80px]';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      hint,
      error,
      state = 'default',
      size = 'md',
      fullWidth = true,
      id: providedId,
      className = '',
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const id = providedId ?? generatedId;
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const hasHint = !!hint;
    const hasError = !!error;
    const ariaDescribedBy = [hasHint && hintId, hasError && errorId].filter(Boolean).join(' ') || undefined;

    const effectiveState = hasError ? 'error' : state;

    return (
      <div className={fullWidth ? 'w-full' : ''}>
        {label && (
          <label
            htmlFor={id}
            className="block text-sm font-medium text-surface-700 mb-1.5 dark:text-surface-300"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={id}
          aria-describedby={ariaDescribedBy}
          aria-invalid={hasError}
          aria-errormessage={hasError ? errorId : undefined}
          className={[
            baseStyles,
            stateStyles[effectiveState],
            sizeStyles[size],
            className,
          ].join(' ')}
          {...props}
        />
        {hasError && (
          <p id={errorId} className="mt-1.5 text-sm text-danger-600 dark:text-danger-400" role="alert">
            {error}
          </p>
        )}
        {hasHint && !hasError && (
          <p id={hintId} className="mt-1.5 text-sm text-surface-500 dark:text-surface-400">
            {hint}
          </p>
        )}
      </div>
    );
  },
);

Textarea.displayName = 'Textarea';

export default Textarea;