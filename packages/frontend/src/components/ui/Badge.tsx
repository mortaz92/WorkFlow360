import { type HTMLAttributes, forwardRef } from 'react';

export type BadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'outline'
  | 'outline-primary'
  | 'outline-success'
  | 'outline-warning'
  | 'outline-danger'
  | 'outline-info';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeShape = 'rounded' | 'pill';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  shape?: BadgeShape;
  dot?: boolean;
  dotColor?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-surface-100 text-surface-700 dark:bg-surface-700 dark:text-surface-300',
  primary: 'bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-300',
  success: 'bg-success-100 text-success-800 dark:bg-success-900/30 dark:text-success-300',
  warning: 'bg-warning-100 text-warning-800 dark:bg-warning-900/30 dark:text-warning-300',
  danger: 'bg-danger-100 text-danger-800 dark:bg-danger-900/30 dark:text-danger-300',
  info: 'bg-info-100 text-info-800 dark:bg-info-900/30 dark:text-info-300',
  outline: 'bg-transparent border border-surface-300 text-surface-700 dark:border-surface-600 dark:text-surface-300',
  'outline-primary': 'bg-transparent border border-primary-500 text-primary-700 dark:border-primary-400 dark:text-primary-300',
  'outline-success': 'bg-transparent border border-success-500 text-success-700 dark:border-success-400 dark:text-success-300',
  'outline-warning': 'bg-transparent border border-warning-500 text-warning-700 dark:border-warning-400 dark:text-warning-300',
  'outline-danger': 'bg-transparent border border-danger-500 text-danger-700 dark:border-danger-400 dark:text-danger-300',
  'outline-info': 'bg-transparent border border-info-500 text-info-700 dark:border-info-400 dark:text-info-300',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-0.5 text-xs',
  lg: 'px-3 py-1 text-sm',
};

const shapeStyles: Record<BadgeShape, string> = {
  rounded: 'rounded-md',
  pill: 'rounded-full',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      variant = 'default',
      size = 'md',
      shape = 'pill',
      dot = false,
      dotColor,
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <span
        ref={ref}
        className={[
          'inline-flex items-center gap-1.5 font-medium',
          variantStyles[variant],
          sizeStyles[size],
          shapeStyles[shape],
          className,
        ].join(' ')}
        {...props}
      >
        {dot && (
          <span
            className="flex-shrink-0 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dotColor || 'currentColor' }}
            aria-hidden="true"
          />
        )}
        {children}
      </span>
    );
  },
);

Badge.displayName = 'Badge';

export default Badge;