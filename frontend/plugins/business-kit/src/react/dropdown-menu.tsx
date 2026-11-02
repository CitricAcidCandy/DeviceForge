import { useState } from 'react';
import type { ComponentProps } from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';
import { hostUi } from '@deviceforge/plugin-sdk';

type ContentProps = ComponentProps<typeof Primitive.Content>;
type PortalHook = NonNullable<ReturnType<typeof hostUi>['usePortalContentRef']>;

/** 公开弹层适配复用宿主归属钩子，业务插件不导入宿主组件实现。 */
export function DropdownMenuContent(props: ContentProps) {
  const [useRef] = useState(() => hostUi().usePortalContentRef);
  return useRef ? <OwnedContent {...props} useContentRef={useRef} /> : <ContentBody {...props} />;
}
function OwnedContent({ useContentRef, ref, ...props }: ContentProps & { readonly useContentRef: PortalHook }) {
  const contentRef = useContentRef(ref);
  return <ContentBody {...props} ref={contentRef} />;
}
function ContentBody({ className, sideOffset = 4, ...props }: ContentProps) {
  return <Primitive.Portal><Primitive.Content data-slot="dropdown-menu-content"
    sideOffset={sideOffset}
    className={hostUi().cn(
      'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none',
      className,
    )} {...props} /></Primitive.Portal>;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={hostUi().cn(
    'relative flex cursor-default select-none items-center rounded-sm outline-none focus:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
    className,
  )} {...props} />;
}
export function DropdownMenuRadioItem({ className, ...props }: ComponentProps<typeof Primitive.RadioItem>) {
  return <Primitive.RadioItem className={hostUi().cn(
    'relative block cursor-default select-none rounded-lg outline-none focus:bg-surface-hover',
    className,
  )} {...props} />;
}
export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuLabel = Primitive.Label;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export const DropdownMenuSeparator = Primitive.Separator;
