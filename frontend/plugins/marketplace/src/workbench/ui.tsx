import type { ReactNode } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@deviceforge/business-kit/dialog';
export * from '@deviceforge/business-kit/dialog';
export * from '@deviceforge/business-kit/sheet';
export { SelectField } from '@deviceforge/business-kit/select-field';
export const Button: ReturnType<typeof hostUi>['Button'] = (props) => { const Component = hostUi().Button; return <Component {...props} />; };
export const Badge: ReturnType<typeof hostUi>['Badge'] = (props) => { const Component = hostUi().Badge; return <Component {...props} />; };
export const Input: ReturnType<typeof hostUi>['Input'] = (props) => { const Component = hostUi().Input; return <Component {...props} />; };
export const Textarea: ReturnType<typeof hostUi>['Textarea'] = (props) => { const Component = hostUi().Textarea; return <Component {...props} />; };
export const Checkbox: ReturnType<typeof hostUi>['Checkbox'] = (props) => { const Component = hostUi().Checkbox; return <Component {...props} />; };
export const FormGrid: ReturnType<typeof hostUi>['FormGrid'] = (props) => { const Component = hostUi().FormGrid; return <Component {...props} />; };
export const FormRow: ReturnType<typeof hostUi>['FormRow'] = (props) => { const Component = hostUi().FormRow; return <Component {...props} />; };
export const FormSection: ReturnType<typeof hostUi>['FormSection'] = (props) => { const Component = hostUi().FormSection; return <Component {...props} />; };
export const FileDropzone: ReturnType<typeof hostUi>['FileDropzone'] = (props) => { const Component = hostUi().FileDropzone; return <Component {...props} />; };
export const Stepper: ReturnType<typeof hostUi>['Stepper'] = (props) => { const Component = hostUi().Stepper; return <Component {...props} />; };
export const JsonResult: ReturnType<typeof hostUi>['JsonResult'] = (props) => { const Component = hostUi().JsonResult; return <Component {...props} />; };
const sizes = { sm: 'w-[min(100%-32px,440px)] max-w-[min(100%-32px,440px)]', md: 'w-[min(100%-32px,600px)] max-w-[min(100%-32px,600px)]',
  lg: 'w-[min(100%-32px,780px)] max-w-[min(100%-32px,780px)]', xl: 'w-[min(100%-32px,1000px)] max-w-[min(100%-32px,1000px)]' };
export function DialogShell(props: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly title: ReactNode;
  readonly description?: ReactNode; readonly children?: ReactNode; readonly footer?: ReactNode;
  readonly className?: string; readonly size?: keyof typeof sizes; readonly closeDisabled?: boolean;
}) {
  return <Dialog open={props.open} onOpenChange={(open) => { if (open || !props.closeDisabled) props.onOpenChange(open); }}>
    <DialogContent showCloseButton={!props.closeDisabled}
      className={hostUi().cn('flex max-h-[min(90dvh,920px)] flex-col gap-0 overflow-hidden rounded-[14px] bg-surface-elevated p-0', sizes[props.size ?? 'md'], props.className)}
      onEscapeKeyDown={(event) => { if (props.closeDisabled) event.preventDefault(); }}
      onInteractOutside={(event) => { if (props.closeDisabled) event.preventDefault(); }}>
      <DialogHeader className="shrink-0 gap-[9px] border-b px-[26px] pt-6 pr-[52px] pb-5 text-left max-[540px]:px-5">
        <DialogTitle className="leading-normal">{props.title}</DialogTitle>
        {props.description !== undefined && <DialogDescription className="leading-relaxed">{props.description}</DialogDescription>}
      </DialogHeader>
      {props.children !== undefined && <div className="min-h-0 min-w-0 overflow-auto overscroll-contain px-[26px] py-6 max-[540px]:p-5">{props.children}</div>}
      {props.footer !== undefined && <DialogFooter className="shrink-0 border-t bg-muted/50 px-[26px] py-4 max-[540px]:px-5">{props.footer}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}
