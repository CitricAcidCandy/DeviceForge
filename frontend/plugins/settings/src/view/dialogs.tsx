import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export function DialogContent({ children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal>
    <Primitive.Overlay className="fixed inset-0 z-50 bg-black/25" />
    <Primitive.Content {...props} className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-hairline bg-card p-6 shadow-xl">
      {children}
      <Primitive.Close className="absolute right-3 top-3 rounded px-2 py-1 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="关闭确认窗口">关闭</Primitive.Close>
    </Primitive.Content>
  </Primitive.Portal>;
}
export function DialogHeader({ children }: ComponentProps<'div'>) {
  return <div className="mb-5 flex flex-col gap-2 pr-12">{children}</div>;
}
export function DialogFooter({ children }: ComponentProps<'div'>) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>;
}
