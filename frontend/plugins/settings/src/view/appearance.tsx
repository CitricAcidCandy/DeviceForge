import { useEffect, useState } from 'react';
import type { ThemeSnapshot } from '@deviceforge/plugin-sdk';
import type { SettingsServices } from '../services.ts';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useAction } from '../view-support.tsx';
import { SettingsFailure, settingsInputClass } from './primitives.tsx';

export function AppearanceSettings({ services }: { services: SettingsServices }) {
  const themes = services.context.themes;
  const [state, setState] = useState<ThemeSnapshot | null>(() => themes?.snapshot() ?? null);
  const action = useAction();
  useEffect(() => {
    setState(themes?.snapshot() ?? null);
    const stop = themes?.subscribe(setState);
    return () => { void stop?.(); };
  }, [themes]);
  return <div className="mt-7 flex flex-col gap-5">
    <Label htmlFor="settings-theme" className="text-[13px] font-normal text-body">界面主题</Label>
    <Select value={state?.selected?.id ?? 'base'} disabled={!themes || action.pending}
      onValueChange={(value) => { void action.run(async () => { themes?.select(value === 'base' ? null : value); }); }}>
      <SelectTrigger id="settings-theme" className={`${settingsInputClass} w-full max-w-[520px]`}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="base">默认外观</SelectItem>
        {state?.themes.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.title} · {theme.pluginId}</SelectItem>)}
      </SelectContent>
    </Select>
    <p className="text-[12px] leading-6 text-muted-foreground">主题由插件提供；卸载主题插件后恢复默认，不影响业务草稿。</p>
    <SettingsFailure error={action.error} logId={action.logId} />
  </div>;
}
