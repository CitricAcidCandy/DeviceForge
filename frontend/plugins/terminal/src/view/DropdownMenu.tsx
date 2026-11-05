import type { ComponentProps } from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';
import { hostUi } from '@deviceforge/plugin-sdk';
import { DropdownMenuContent as OwnedContent } from '@deviceforge/business-kit/dropdown-menu';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

/** 保留原终端菜单外观，经公开适配登记弹层归属。 */
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <OwnedContent sideOffset={sideOffset} {...props}
    className={hostUi().cn('z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className)} />;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item {...props}
    className={hostUi().cn("relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground", className)} />;
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label {...props} className={hostUi().cn('px-2 py-1.5 text-sm font-medium', className)} />;
}
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator {...props} className={hostUi().cn('-mx-1 my-1 h-px bg-border', className)} />;
}
