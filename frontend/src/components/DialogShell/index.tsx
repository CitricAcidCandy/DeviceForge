import type { ReactNode } from 'react';
import { cn } from '../../utils/classnames.ts';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../Dialog/index.tsx';
import './styles.css';

export interface DialogShellProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
  readonly closeDisabled?: boolean;
}

export function DialogShell({
  open, onOpenChange, title, description, children, footer, className,
  size = 'md', closeDisabled = false,
}: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (next || !closeDisabled) onOpenChange(next); }}>
      <DialogContent
        className={cn('ui-dialog-shell', className)}
        data-size={size}
        showCloseButton={!closeDisabled}
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        onEscapeKeyDown={(event) => { if (closeDisabled) event.preventDefault(); }}
        onInteractOutside={(event) => { if (closeDisabled) event.preventDefault(); }}
      >
        <DialogHeader className="ui-dialog-shell-header">
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children !== undefined && <div className="ui-dialog-shell-body">{children}</div>}
        {footer !== undefined && <DialogFooter className="ui-dialog-shell-footer">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
