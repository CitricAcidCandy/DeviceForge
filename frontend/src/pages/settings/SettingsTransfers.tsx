import { useState } from 'react';
import { CloudDownload, CloudUpload, Trash2, Upload } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { Switch } from '../../components/Switch/index.tsx';
import { Textarea } from '../../components/Textarea/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/Dialog/index.tsx';
import { isJsonData, jsonObject } from '../../shared/jobs/index.ts';
import { remoteSettingSections } from '../../features/settings/index.ts';
import type { RemoteSettingsResult, SettingsOwner, SettingsResult } from '../../features/settings/index.ts';
import { useAction } from '../../app/product/hooks.ts';
import { useOperationAvailable } from '../../app/product/capabilities.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { settingsButtonClass, settingsCodeClass, settingsInputClass, SettingsFailure, SettingsGroup } from './primitives.tsx';

export function SettingsTransfers({ services, owner, section, configuration, onUpdated }: {
  services: ProductServices;
  owner: SettingsOwner;
  section: string;
  configuration: SettingsResult | null;
  onUpdated(value: SettingsResult | null): void;
}) {
  const [sections, setSections] = useState('{}');
  const [legacyFiles, setLegacyFiles] = useState<readonly File[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [remoteSection, setRemoteSection] = useState('deviceInfo');
  const [remoteDraft, setRemoteDraft] = useState('{}');
  const [backup, setBackup] = useState(true);
  const [remoteResult, setRemoteResult] = useState<RemoteSettingsResult | null>(null);
  const action = useAction();
  const canDelete = useOperationAvailable(services, 'plugin.settings.delete');
  const canImport = useOperationAvailable(services, 'plugin.settings.import');
  const canLoadRemote = useOperationAvailable(services, 'plugin.settings.remote.load');
  const canSaveRemote = useOperationAvailable(services, 'plugin.settings.remote.save');
  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 [&>button]:self-start">
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className={settingsButtonClass} disabled={!configuration || !canDelete || action.pending}>
              <Trash2 aria-hidden="true" />删除此配置区
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除配置区 {section}</DialogTitle>
              <DialogDescription>
                将删除{owner.scope === 'user' ? '用户' : '工作区'} {owner.owner_id} 的此配置区，使用当前修订校验。此操作不会删除其他配置区。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>保留配置</Button>
              <Button variant="destructive" disabled={!configuration || action.pending} onClick={() => {
                if (!configuration) return;
                void action.run(async (signal) => {
                  const result = await services.settings.delete({ ...owner, section, expected_revision: configuration.revision }, signal);
                  if (!signal.aborted) {
                    onUpdated(result.data);
                    setDeleteOpen(false);
                  }
                  return result;
                }, { success: '配置区已删除' });
              }}>确认删除</Button>
            </DialogFooter>
            <SettingsFailure error={action.error} logId={action.logId} />
          </DialogContent>
        </Dialog>
        <p className="text-[12px] leading-6 text-muted-foreground">删除、导入和远端操作都需要先读取当前归属的修订。</p>
      </div>
      <SettingsGroup title="导入配置">
        <p className="text-[12px] leading-6 text-muted-foreground">以配置区名为键的 JSON 对象；整批校验成功后提交一次，冲突时不会覆盖。</p>
        <div className="space-y-2">
          <Label htmlFor="settings-import" className="text-[13px] font-normal text-body">配置区集合 · JSON</Label>
          <Textarea id="settings-import" className={settingsCodeClass} value={sections} onChange={(event) => setSections(event.target.value)} rows={6} />
        </div>
        <Button variant="outline" className={settingsButtonClass} disabled={!configuration || !canImport || action.pending} onClick={() => {
          if (!configuration) return;
          void action.run(async (signal) => {
            const value: unknown = JSON.parse(sections);
            if (!jsonObject(value)) throw new Error('导入内容须为以配置区名为键的 JSON 对象');
            const result = await services.settings.import({ ...owner, sections: value, expected_revision: configuration.revision }, signal);
            if (!signal.aborted) onUpdated(result.data);
            return result;
          }, { success: '配置区已导入' });
        }}><Upload aria-hidden="true" />导入配置区</Button>
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-legacy" className="text-[13px] font-normal text-body">旧工程备份 · 可选择多个 JSON 文件</Label>
          <Input id="settings-legacy" className={settingsInputClass} type="file" accept=".json" multiple onChange={(event) => setLegacyFiles(Array.from(event.target.files ?? []))} />
          <p className="break-words text-[12px] leading-6 text-muted-foreground">
            支持 deviceInfo、packageInfo、iframePageUrl、permissions、luaCommand、dynamicSnalysisHooks 和 packageSdk 的原文件名。
          </p>
        </div>
        <Button variant="outline" className={settingsButtonClass} disabled={!configuration || !canImport || legacyFiles.length === 0 || action.pending} onClick={() => {
          if (!configuration) return;
          void action.run(async (signal) => {
            const files = await Promise.all(legacyFiles.map(async (file) => ({ name: file.name, text: await file.text() })));
            if (signal.aborted) throw new Error('已取消旧备份读取');
            const result = await services.settings.importLegacy({ ...owner, expected_revision: configuration.revision, files }, signal);
            if (!signal.aborted) onUpdated(result.data);
            return result;
          }, { success: '旧备份已导入' });
        }}>导入旧备份</Button>
      </SettingsGroup>
      <SettingsGroup title="远端配置与本地备份">
        <p className="text-[12px] leading-6 text-muted-foreground">远端服务由服务器部署配置提供。读取可能返回本地备份；保存成功与本地备份成功分别展示。</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2 sm:max-w-[360px]">
            <Label htmlFor="remote-section" className="text-[13px] font-normal text-body">兼容配置区</Label>
            <Select value={remoteSection} onValueChange={(value) => {
              action.cancel();
              setRemoteSection(value);
              setRemoteResult(null);
            }}>
              <SelectTrigger id="remote-section" className={`${settingsInputClass} w-full`}><SelectValue /></SelectTrigger>
              <SelectContent>{remoteSettingSections.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button variant="outline" className={settingsButtonClass} disabled={!configuration || !canLoadRemote || action.pending} onClick={() => {
            if (!configuration) return;
            void action.run(async (signal) => {
              const result = await services.settings.loadRemote({ ...owner, section: remoteSection, expected_revision: configuration.revision }, signal);
              if (!signal.aborted) {
                setRemoteResult(result.data);
                setRemoteDraft(JSON.stringify(result.data.value, null, 2));
                onUpdated(result.data.revision === null ? null : { format_version: 1, revision: result.data.revision });
              }
              return result;
            }, { success: '远端读取结果已更新' });
          }}><CloudDownload aria-hidden="true" />读取远端</Button>
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-content" className="text-[13px] font-normal text-body">远端内容 · JSON 原值</Label>
          <Textarea id="remote-content" className={settingsCodeClass} value={remoteDraft} onChange={(event) => setRemoteDraft(event.target.value)} rows={7} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor="remote-backup" className="text-[13px] font-normal text-body">保存远端时更新本地备份</Label>
          <Switch id="remote-backup" checked={backup} onCheckedChange={setBackup} />
        </div>
        <Button className={settingsButtonClass} disabled={!configuration || !canSaveRemote || action.pending} onClick={() => {
          if (!configuration) return;
          void action.run(async (signal) => {
            const value: unknown = JSON.parse(remoteDraft);
            if (!isJsonData(value)) throw new Error('远端内容须为合法 JSON 数据');
            const result = await services.settings.saveRemote({ ...owner, section: remoteSection, value, expected_revision: configuration.revision, write_local_backup: backup }, signal);
            if (!signal.aborted) {
              setRemoteResult(result.data);
              onUpdated(result.data.revision === null ? null : { format_version: 1, revision: result.data.revision });
            }
            return result;
          }, { success: '远端保存结果已更新，请核对提交与备份状态' });
        }}><CloudUpload aria-hidden="true" />保存远端</Button>
        {remoteResult && (
          <p role="status" className="text-[12px] leading-6 text-muted-foreground">
            实际来源：{remoteResult.source === 'remote' ? '远端服务' : '本地备份'} · 远端已提交：
            {remoteResult.remote_committed ? '是' : '否'} · 本地备份已更新：{remoteResult.backup_updated ? '是' : '否'}
            {remoteResult.revision === null ? '。请重新读取本地修订后继续写入。' : ''}
          </p>
        )}
      </SettingsGroup>
      <SettingsFailure error={action.error} logId={action.logId} />
    </div>
  );
}
