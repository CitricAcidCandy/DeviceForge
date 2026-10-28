import { Label } from '../../components/Label/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { settingsInputClass, SettingsFailure } from './primitives.tsx';

export function AppearanceSettings({ services }: { services: ProductServices }) {
  const themes = useSnapshot(services.runtime.themes);
  const action = useAction();
  return (
    <div className="mt-7 flex flex-col gap-5">
      <div className="grid items-start gap-3 sm:grid-cols-[104px_minmax(0,520px)] sm:gap-6">
        <Label htmlFor="settings-theme" className="min-h-9 text-[14px] font-normal text-body">
          工作空间主题
        </Label>
        <div>
          <Select
            value={themes.selected?.id ?? 'base'}
            disabled={action.pending}
            onValueChange={(value) => {
              void action.run(async () => services.runtime.themes.select(value === 'base' ? null : value), { quiet: true });
            }}
          >
            <SelectTrigger id="settings-theme" className={`${settingsInputClass} w-full`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="base">工坊默认主题</SelectItem>
              {themes.themes.map((theme) => (
                <SelectItem value={theme.id} key={theme.id}>{theme.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2! text-[12px] leading-6 text-muted-foreground">
            主题选择成功后生效；插件移除后恢复默认主题。
          </p>
        </div>
      </div>
      <p className="text-[12px] leading-6 text-muted-foreground sm:ml-32!">
        专注模式和减少动态效果可在右上角设置；系统的减少动态效果偏好自动生效。
      </p>
      <div className="sm:ml-32"><SettingsFailure error={action.error} logId={action.logId} /></div>
    </div>
  );
}
