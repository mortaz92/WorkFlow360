import { forwardRef, type SelectHTMLAttributes, useId } from 'react';

export type SelectSize = 'sm' | 'md' | 'lg';
export type SelectState = 'default' | 'error' | 'success';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  state?: SelectState;
  size?: SelectSize;
  options: SelectOption[];
  placeholder?: string;
  fullWidth?: boolean;
}

const sizeStyles: Record<SelectSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-3 py-2.5 text-sm',
  lg: 'px-4 py-3 text-base',
};

const stateStyles: Record<SelectState, string> = {
  default: 'border-surface-300 focus:border-primary-600 focus:ring-primary-200 dark:border-surface-600 dark:focus:border-primary-400 dark:focus:ring-primary-900/30',
  error: 'border-danger-500 focus:border-danger-500 focus:ring-danger-200 dark:border-danger-400 dark:focus:border-danger-400 dark:focus:ring-danger-900/30',
  success: 'border-success-500 focus:border-success-500 focus:ring-success-200 dark:border-success-400 dark:focus:border-success-400 dark:focus:ring-success-900/30',
};

const baseStyles =
  'w-full rounded-lg bg-white text-surface-900 transition-all duration-150 appearance-none ' +
  'focus:outline-none focus:ring-2 focus:ring-offset-0 ' +
  'disabled:bg-surface-100 disabled:text-surface-500 disabled:cursor-not-allowed ' +
  'dark:bg-surface-800 dark:text-surface-100 ' +
  'bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 20 20%27%3E%3Cpath stroke=%27%236b7280%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27 stroke-width=%271.5%27 d=%27M6 8l4 4 4-4%27/%3E%3C/svg%3E")] bg-[length:1.5rem_1.5rem] bg-[right_0.75rem_center] bg-no-repeat pr-10';

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      hint,
      error,
      state = 'default',
      size = 'md',
      options,
      placeholder,
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
        <select
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
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
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

Select.displayName = 'Select';

export default Select;