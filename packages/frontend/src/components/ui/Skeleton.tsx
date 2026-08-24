import { type HTMLAttributes, forwardRef } from 'react';

export type SkeletonVariant = 'text' | 'circular' | 'rectangular' | 'card';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  lines?: number;
  className?: string;
}

const baseStyles = 'animate-pulse bg-surface-200 rounded dark:bg-surface-700';

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ variant = 'text', width, height, lines = 1, className = '', ...props }, ref) => {
    if (variant === 'circular') {
      return (
        <div
          ref={ref}
          className={[baseStyles, 'rounded-full', className].join(' ')}
          style={{ width: width || '3rem', height: height || '3rem' }}
          {...props}
        />
      );
    }

    if (variant === 'rectangular') {
      return (
        <div
          ref={ref}
          className={[baseStyles, className].join(' ')}
          style={{ width: width || '100%', height: height || '1rem' }}
          {...props}
        />
      );
    }

    if (variant === 'card') {
      return (
        <div
          ref={ref}
          className={['rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-700 dark:bg-surface-800', className].join(' ')}
          {...props}
        >
          <div className="flex items-center gap-3">
            <div className={['animate-pulse bg-surface-200 rounded-full dark:bg-surface-700', 'h-10 w-10'].join(' ')} />
            <div className="flex-1 space-y-2">
              <div className="animate-pulse h-4 w-3/4 bg-surface-200 rounded dark:bg-surface-700" />
              <div className="animate-pulse h-4 w-1/2 bg-surface-200 rounded dark:bg-surface-700" />
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {[...Array(lines)].map((_, i) => (
              <div key={i} className="animate-pulse h-4 bg-surface-200 rounded dark:bg-surface-700" style={{ width: i === lines - 1 ? '60%' : '100%' }} />
            ))}
          </div>
        </div>
      );
    }

    // text variant - multiple lines
    return (
      <div ref={ref} className={className} {...props}>
        {[...Array(lines)].map((_, i) => (
          <div
            key={i}
            className={[baseStyles, 'rounded'].join(' ')}
            style={{
              width: i === lines - 1 && width ? `${Number(width) * 0.6}px` : width || '100%',
              height: height || '1rem',
              marginTop: i > 0 ? '0.5rem' : 0,
            }}
          />
        ))}
      </div>
    );
  },
);

Skeleton.displayName = 'Skeleton';

export interface SkeletonCardProps {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 3, className = '' }: SkeletonCardProps) {
  return <Skeleton variant="card" lines={lines} className={className} />;
}

export interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function SkeletonTable({ rows = 5, columns = 4, className = '' }: SkeletonTableProps) {
  return (
    <div className={['overflow-x-auto rounded-xl border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-800', className].join(' ')}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-50 dark:bg-surface-900/50">
            {[...Array(columns)].map((_, i) => (
              <th key={i} className="px-4 py-3">
                <Skeleton variant="rectangular" width="80%" height="0.75rem" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...Array(rows)].map((_, rowIdx) => (
            <tr key={rowIdx} className={rowIdx % 2 === 1 ? 'bg-surface-50/50 dark:bg-surface-900/30' : ''}>
              {[...Array(columns)].map((_, colIdx) => (
                <td key={colIdx} className="px-4 py-3">
                  <Skeleton variant="rectangular" width="90%" height="1rem" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default Skeleton;