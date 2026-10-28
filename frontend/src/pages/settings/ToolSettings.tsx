import { useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { Textarea } from '../../components/Textarea/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import { isJsonData } from '../../shared/jobs/index.ts';
import type { SettingsResult } from '../../features/settings/index.ts';
import { useAction } from '../../app/product/hooks.ts';
import { OperationNotice, useOperationAvailable } from '../../app/product/capabilities.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { SettingsTransfers } from './SettingsTransfers.tsx';
import { settingsButtonClass, settingsCodeClass, settingsInputClass, SettingsFailure, SettingsGroup } from './primitives.tsx';

export function ToolSettings({ services }: { services: ProductServices }) {
  const [scope, setScope] = useState<'user' | 'workspace'>('user');
  const [owner, setOwner] = useState('local');
  const [section, setSection] = useState('general');
  const [draft, setDraft] = useState('{}');
  const [configuration, setConfiguration] = useState<SettingsResult | null>(null);
  const action = useAction();
  const canRead = useOperationAvailable(services, 'plugin.settings.list');
  const canWrite = useOperationAvailable(services, 'plugin.settings.set');
  return (
    <div className="mt-7 space-y-8">
      <OperationNotice services={services} operation="plugin.settings.list" />
      <div className="flex flex-col gap-6 [&>button]:self-start">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-scope" className="text-[13px] font-normal text-body">配置归属</Label>
            <Select value={scope} onValueChange={(value) => {
              if (value === 'user' || value === 'workspace') {
                action.cancel();
                setScope(value);
                setConfiguration(null);
              }
            }}>
              <SelectTrigger id="settings-scope" className={`${settingsInputClass} w-full`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">用户配置</SelectItem>
                <SelectItem value="workspace">工作区配置</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-owner" className="text-[13px] font-normal text-body">归属 ID</Label>
            <Input id="settings-owner" className={settingsInputClass} value={owner} onChange={(event) => {
              action.cancel();
              setOwner(event.target.value);
              setConfiguration(null);
            }} />
          </div>
        </div>
        <Button variant="outline" className={settingsButtonClass} disabled={action.pending || !canRead} onClick={() => {
          void action.run(async (signal) => {
            const result = await services.settings.list({ scope, owner_id: owner }, signal);
            if (!signal.aborted) setConfiguration(result.data);
            return result;
          }, { success: '配置目录已读取' });
        }}>
          <RefreshCw aria-hidden="true" />读取配置
        </Button>
        {configuration && (
          <p className="text-[12px] leading-6 text-muted-foreground">
            当前修订：<span className="font-mono">{configuration.revision}</span> · 配置区：
            {Object.keys(configuration.sections ?? {}).join('、') || '没有配置区'}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2 sm:max-w-[360px]">
            <Label htmlFor="settings-section" className="text-[13px] font-normal text-body">配置区</Label>
            <Input id="settings-section" className={settingsInputClass} value={section} onChange={(event) => {
              action.cancel();
              setSection(event.target.value);
            }} />
          </div>
          <Button variant="outline" className={settingsButtonClass} disabled={action.pending || !canRead} onClick={() => {
            void action.run(async (signal) => {
              const result = await services.settings.get({ scope, owner_id: owner, section }, signal);
              if (!signal.aborted) {
                setConfiguration(result.data);
                setDraft(JSON.stringify(result.data.value ?? null, null, 2));
              }
              return result;
            }, { success: '配置区已读取' });
          }}>读取此区</Button>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-content" className="text-[13px] font-normal text-body">配置内容 · JSON</Label>
          <Textarea id="settings-content" className={settingsCodeClass} value={draft} onChange={(event) => setDraft(event.target.value)} rows={9} />
          <p className="text-[12px] leading-6 text-muted-foreground">写入使用已读取的修订；出现冲突时重新读取，不会自动覆盖。</p>
        </div>
        <Button className={settingsButtonClass} disabled={!configuration || !canWrite || action.pending} onClick={() => {
          if (!configuration) return;
          void action.run(async (signal) => {
            const value: unknown = JSON.parse(draft);
            if (!isJsonData(value)) throw new Error('配置必须为合法的 JSON 数据');
            const result = await services.settings.set({ scope, owner_id: owner, section, expected_revision: configuration.revision, value }, signal);
            if (!signal.aborted) setConfiguration(result.data);
            return result;
          }, { success: '配置区已保存' });
        }}><Save aria-hidden="true" />保存此区</Button>
        <SettingsFailure error={action.error} logId={action.logId} />
      </div>
      <details className="border-t border-hairline pt-5">
        <summary className="text-[14px]! font-medium! text-body">导入与远端配置</summary>
        <div className="pt-5">
          <SettingsTransfers key={`${scope}:${owner}`} services={services} owner={{ scope, owner_id: owner }} section={section} configuration={configuration} onUpdated={setConfiguration} />
        </div>
      </details>
      <SettingsGroup title="服务器产物">
        <p className="text-[12px] leading-6 text-muted-foreground">凭任务结果里的产物 ID 取用，占用服务器而不占用设备。</p>
        <Button variant="outline" className={settingsButtonClass} asChild><a href="#files">打开产物库</a></Button>
      </SettingsGroup>
    </div>
  );
}
