import type { ComponentProps } from 'react';
import { cn } from '../../utils/classnames.ts';
import './styles.css';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'info' | 'danger' | 'warm' | 'violet';

export function Badge({ className, variant = 'secondary', ...props }: ComponentProps<'span'> & {
  variant?: BadgeVariant;
}) {
  return <span data-slot="badge" data-variant={variant} className={cn('ui-badge', className)} {...props} />;
}
