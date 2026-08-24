import { type HTMLAttributes, forwardRef, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => ReactNode;
  className?: string;
  headerClassName?: string;
  width?: string;
}

interface TableProps<T> extends HTMLAttributes<HTMLTableElement> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  rowClassName?: (row: T, index: number) => string;
  emptyMessage?: string;
  emptyIcon?: ReactNode;
  striped?: boolean;
  hoverable?: boolean;
  bordered?: boolean;
  stickyHeader?: boolean;
  caption?: string;
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  rowClassName,
  emptyMessage = 'Nessun dato disponibile',
  emptyIcon,
  striped = true,
  hoverable = true,
  bordered = true,
  stickyHeader = true,
  caption,
  className = '',
  ...props
}: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-800">
      <table
        className={['w-full border-collapse', className].join(' ')}
        {...props}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={[stickyHeader ? 'sticky top-0 z-10' : '', 'bg-surface-50 dark:bg-surface-900/50'].join(' ')} >
          <tr className={bordered ? 'border-b border-surface-200 dark:border-surface-700' : ''}>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={{ width: col.width }}
                className={[
                  'px-4 py-3 text-left text-xs font-semibold tracking-wider text-surface-500 uppercase',
                  col.headerClassName,
                ].join(' ')}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-200 dark:divide-surface-700">
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center">
                <div className="flex flex-col items-center gap-3 text-surface-500 dark:text-surface-400">
                  {emptyIcon && (
                    <div className="text-surface-300 dark:text-surface-600" aria-hidden="true">
                      {emptyIcon}
                    </div>
                  )}
                  <p className="m-0 text-sm font-medium">{emptyMessage}</p>
                </div>
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <tr
                key={keyExtractor(row)}
                className={[
                  hoverable ? 'hover:bg-surface-50 dark:hover:bg-surface-900/50' : '',
                  striped && index % 2 === 1 ? 'bg-surface-50/50 dark:bg-surface-900/30' : '',
                  rowClassName?.(row, index),
                ].join(' ')}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={[
                      'px-4 py-3 text-sm text-surface-900 dark:text-surface-100',
                      col.className,
                    ].join(' ')}
                  >
                    {col.render ? col.render(row, index) : (row as any)[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface TableToolbarProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  actions?: ReactNode;
  filters?: ReactNode;
}

export const TableToolbar = forwardRef<HTMLDivElement, TableToolbarProps>(
  ({ title, description, actions, filters, className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          'mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4',
          className,
        ].join(' ')}
        {...props}
      >
        <div>
          {title && <h2 className="m-0 text-lg font-semibold text-surface-900 dark:text-surface-100">{title}</h2>}
          {description && <p className="mt-0.5 text-sm text-surface-500 dark:text-surface-400">{description}</p>}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          {filters && <div className="flex-1">{filters}</div>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      </div>
    );
  },
);

TableToolbar.displayName = 'TableToolbar';

export default Table;