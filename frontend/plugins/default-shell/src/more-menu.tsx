import { useState } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@deviceforge/business-kit/dropdown-menu';

/** 顶栏只发出原设置意图；键盘、焦点、碰撞避让和弹层归属复用公开菜单。 */
export function MoreSettings({ reduced, onReduced, onRefresh, navigate }: {
  readonly reduced: boolean;
  readonly onReduced: () => void;
  readonly onRefresh: () => void;
  readonly navigate: (route: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const item = 'gap-2 px-2 py-1.5 text-sm';
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label="更多设置" title="更多设置"
        className="flex size-7 shrink-0 items-center justify-center rounded text-lg hover:bg-[#F5F6FB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <span aria-hidden="true">⋯</span>
      </button>
    </DropdownMenuTrigger>
    {open && <DropdownMenuContent align="end" collisionPadding={12}
      className="min-w-48 max-w-[calc(100vw-24px)] border-hairline">
      <DropdownMenuItem className={item} onSelect={onRefresh}>重新连接服务器</DropdownMenuItem>
      <DropdownMenuItem className={item} role="menuitemcheckbox" aria-checked={reduced} onSelect={onReduced}>
        <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">{reduced ? '✓' : ''}</span>
        减少动态效果
      </DropdownMenuItem>
      <DropdownMenuItem className={item} onSelect={() => navigate('/settings')}>主题与设置</DropdownMenuItem>
      <DropdownMenuItem className={item} onSelect={() => navigate('/marketplace')}>管理插件</DropdownMenuItem>
    </DropdownMenuContent>}
  </DropdownMenu>;
}
