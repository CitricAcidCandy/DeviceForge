import { useState } from 'react';
import { Save, RefreshCw, Palette, Settings2, Eye, EyeOff, Trash2, Upload, CloudDownload, CloudUpload } from 'lucide-react';
import { Button } from '../../../components/Button/index.tsx';
import { Input } from '../../../components/Input/index.tsx';
import { Textarea } from '../../../components/Textarea/index.tsx';
import { Label } from '../../../components/Label/index.tsx';
import { Switch } from '../../../components/Switch/index.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../../components/Dialog/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/Select/index.tsx';
import { isJsonData, jsonObject } from '../../../shared/jobs/index.ts';
import { remoteSettingSections } from '../../../features/settings/index.ts';
import type { RemoteSettingsResult, SettingsOwner, SettingsResult } from '../../../features/settings/index.ts';
import type { ProductServices } from '../services.ts';
import { useAction, useSnapshot } from '../hooks.ts';
import { Field, JsonResult, PageTitle } from '../../../components/index.ts';
import { OperationNotice, useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback } from '../feedback.tsx';
import { McpConnection } from '../mcp-connection.tsx';

export function SettingsPage({ services }: { services: ProductServices }) {
  const [scope, setScope] = useState<'user' | 'workspace'>('user');
  const [owner, setOwner] = useState('local');
  const [section, setSection] = useState('general');
  const [draft, setDraft] = useState('{}');
  const [configuration, setConfiguration] = useState<SettingsResult | null>(null);
  const [baseUrl, setBaseUrl] = useState(() => services.connection?.baseUrl ?? (typeof location === 'undefined' ? '' : location.origin));
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const action = useAction();
  const themes = useSnapshot(services.runtime.themes);
  const canRead = useOperationAvailable(services, 'plugin.settings.list');
  const canWrite = useOperationAvailable(services, 'plugin.settings.set');
  function changeOwner(value: string) { action.cancel(); setOwner(value); setConfiguration(null); }
  return <div className="product-page"><PageTitle eyebrow="WORKSHOP / PREFERENCES" title="把工坊调整得顺手" description="主题、服务和当前工具配置，各归其位。" />
    <section className="settings-group"><div className="section-heading"><h2><Palette />主题与显示</h2></div><div className="setting-row"><div><Label htmlFor="settings-theme">工作空间主题</Label><p className="muted">即时应用真实主题贡献，不改变设备和任务状态。</p></div><Select value={themes.selected?.id ?? 'base'} onValueChange={(value) => { void action.run(async () => services.runtime.themes.select(value === 'base' ? null : value)); }}><SelectTrigger id="settings-theme"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="base">工坊默认主题</SelectItem>{themes.themes.map((theme) => <SelectItem value={theme.id} key={theme.id}>{theme.title}</SelectItem>)}</SelectContent></Select></div><p className="muted">专注模式和减少动态效果可在页面右上方随时调整。系统的减少动态效果设置会自动生效。</p></section>
    <section className="settings-group"><h2>服务连接</h2><p>当前服务：<span className="mono">{services.connection?.baseUrl ?? (typeof location === 'undefined' ? '同源服务' : location.origin)}</span></p><p className="muted">本地与同事局域网部署默认免鉴权。可选令牌由运行会话提供，不进入网址或浏览器持久存储。</p>{services.connection && <><div className="form-row"><div className="grow"><Field label="服务地址" value={baseUrl} onChange={setBaseUrl} placeholder="http://127.0.0.1:7031" hint="此处是待应用的地址，测试成功后切换工作会话" /></div><Button disabled={action.pending} onClick={() => { void action.run(async signal => services.connection?.reconnect(baseUrl, token, signal)); }}><RefreshCw />测试并应用</Button></div><div className="form-row"><div className="grow"><Field label="可选服务令牌" value={token} onChange={setToken} type={showToken ? 'text' : 'password'} hint="留空使用免鉴权服务；仅保存在当前工作会话" /></div><Button variant="outline" onClick={() => setShowToken(!showToken)} aria-label={showToken ? '隐藏服务令牌' : '显示服务令牌'}>{showToken ? <EyeOff /> : <Eye />}{showToken ? '隐藏' : '显示'}</Button></div><p className="muted">切换服务会结束当前浏览器工作会话；已提交任务仍以原服务器状态为准。</p></>}</section>
    <section className="settings-group"><h2><Settings2 />工具配置</h2><OperationNotice services={services} operation="plugin.settings.list" /><div className="form-row"><div className="form-field"><Label htmlFor="settings-scope">配置归属</Label><Select value={scope} onValueChange={(value) => { if (value === 'user' || value === 'workspace') { action.cancel(); setScope(value); setConfiguration(null); } }}><SelectTrigger id="settings-scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">用户配置</SelectItem><SelectItem value="workspace">工作区配置</SelectItem></SelectContent></Select></div><Field label="归属 ID" value={owner} onChange={changeOwner} hint="显式归属，避免覆盖其他配置" /><Button variant="outline" disabled={action.pending || !canRead} onClick={() => { void action.run(async (signal) => { const result = await services.settings.list({ scope, owner_id: owner }, signal); if (!signal.aborted) setConfiguration(result.data); return result; }); }}><RefreshCw />读取配置</Button></div>
      {configuration && <p className="muted">当前修订：<span className="mono">{configuration.revision}</span> · 配置区：{Object.keys(configuration.sections ?? {}).join('、') || '没有配置区'}</p>}
      <div className="form-row"><Field label="配置区" value={section} onChange={(value) => { action.cancel(); setSection(value); }} /><Button variant="outline" disabled={action.pending || !canRead} onClick={() => { void action.run(async (signal) => { const result = await services.settings.get({ scope, owner_id: owner, section }, signal); if (!signal.aborted) { setConfiguration(result.data); setDraft(JSON.stringify(result.data.value ?? null, null, 2)); } return result; }); }}>读取此区</Button></div>
      <div className="form-field"><Label htmlFor="settings-content">配置内容 · JSON</Label><Textarea id="settings-content" className="code-input" value={draft} onChange={(event) => setDraft(event.target.value)} rows={9} /><small>写入使用已读取的修订；出现冲突时重新读取，不会自动覆盖。</small></div><Button disabled={!configuration || !canWrite || action.pending} onClick={() => { if (!configuration) return; void action.run(async (signal) => { const value: unknown = JSON.parse(draft); if (!isJsonData(value)) throw new Error('配置必须为合法的 JSON 数据'); const result = await services.settings.set({ scope, owner_id: owner, section, expected_revision: configuration.revision, value }, signal); if (!signal.aborted) setConfiguration(result.data); return result; }); }}><Save />保存此区</Button>
    </section><ActionFeedback {...action} /><JsonResult value={action.result} />
    <section className="settings-group"><h2>MCP 连接与工具目录</h2><McpConnection services={services} /></section>
    <SettingsTransfers key={`${scope}:${owner}`} services={services} owner={{ scope, owner_id: owner }} section={section} configuration={configuration} onUpdated={setConfiguration} />
  </div>;
}

function SettingsTransfers({ services, owner, section, configuration, onUpdated }: { services: ProductServices; owner: SettingsOwner; section: string; configuration: SettingsResult | null; onUpdated(value: SettingsResult | null): void }) {
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
  return <>
    <div className="inline-action settings-group"><Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogTrigger asChild><Button variant="outline" disabled={!configuration || !canDelete || action.pending}><Trash2 />删除此配置区</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>删除配置区 {section}</DialogTitle><DialogDescription>将删除 {owner.scope === 'user' ? '用户' : '工作区'} {owner.owner_id} 的此配置区，使用当前修订校验。此操作不会删除其他配置区。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>保留配置</Button><Button variant="destructive" disabled={!configuration || action.pending} onClick={() => { if (configuration) void action.run(async (signal) => { const result = await services.settings.delete({ ...owner, section, expected_revision: configuration.revision }, signal); if (!signal.aborted) { onUpdated(result.data); setDeleteOpen(false); } return result; }); }}>确认删除</Button></DialogFooter><ActionFeedback {...action} /></DialogContent></Dialog><p className="muted">删除、导入和远端操作都需要先读取当前归属的修订。</p></div>
    <section className="settings-group"><h2>导入配置</h2><p className="muted">以配置区名为键的 JSON 对象；整批校验成功后提交一次，冲突时不会覆盖。</p><div className="form-field"><Label htmlFor="settings-import">配置区集合 · JSON</Label><Textarea id="settings-import" className="code-input" value={sections} onChange={(event) => setSections(event.target.value)} rows={6} /></div><div className="action-row"><Button variant="outline" disabled={!configuration || !canImport || action.pending} onClick={() => { if (configuration) void action.run(async (signal) => { const value: unknown = JSON.parse(sections); if (!jsonObject(value)) throw new Error('导入内容须为以配置区名为键的 JSON 对象'); const result = await services.settings.import({ ...owner, sections: value, expected_revision: configuration.revision }, signal); if (!signal.aborted) onUpdated(result.data); return result; }); }}><Upload />导入配置区</Button></div>
      <div className="form-row"><div className="form-field grow"><Label htmlFor="settings-legacy">旧工程备份 · 可选择多个 JSON 文件</Label><Input id="settings-legacy" type="file" accept=".json" multiple onChange={(event) => setLegacyFiles(Array.from(event.target.files ?? []))} /><small>支持 deviceInfo、packageInfo、iframePageUrl、permissions、luaCommand、dynamicSnalysisHooks 和 packageSdk 的原文件名。</small></div><Button variant="outline" disabled={!configuration || !canImport || legacyFiles.length === 0 || action.pending} onClick={() => { if (configuration) void action.run(async (signal) => { const files = await Promise.all(legacyFiles.map(async (file) => ({ name: file.name, text: await file.text() }))); if (signal.aborted) throw new Error('已取消旧备份读取'); const result = await services.settings.importLegacy({ ...owner, expected_revision: configuration.revision, files }, signal); if (!signal.aborted) onUpdated(result.data); return result; }); }}>导入旧备份</Button></div>
    </section>
    <section className="settings-group"><h2>远端配置与本地备份</h2><p className="muted">远端服务由服务器部署配置提供。读取可能返回本地备份；保存成功与本地备份成功分别展示。</p><div className="form-row"><div className="form-field"><Label htmlFor="remote-section">兼容配置区</Label><Select value={remoteSection} onValueChange={(value) => { action.cancel(); setRemoteSection(value); setRemoteResult(null); }}><SelectTrigger id="remote-section"><SelectValue /></SelectTrigger><SelectContent>{remoteSettingSections.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent></Select></div><Button variant="outline" disabled={!configuration || !canLoadRemote || action.pending} onClick={() => { if (configuration) void action.run(async (signal) => { const result = await services.settings.loadRemote({ ...owner, section: remoteSection, expected_revision: configuration.revision }, signal); if (!signal.aborted) { setRemoteResult(result.data); setRemoteDraft(JSON.stringify(result.data.value, null, 2)); onUpdated(result.data.revision === null ? null : { format_version: 1, revision: result.data.revision }); } return result; }); }}><CloudDownload />读取远端</Button></div>
      <div className="form-field"><Label htmlFor="remote-content">远端内容 · JSON 原值</Label><Textarea id="remote-content" className="code-input" value={remoteDraft} onChange={(event) => setRemoteDraft(event.target.value)} rows={7} /></div><div className="setting-row"><Label htmlFor="remote-backup">保存远端时更新本地备份</Label><Switch id="remote-backup" checked={backup} onCheckedChange={setBackup} /></div><Button disabled={!configuration || !canSaveRemote || action.pending} onClick={() => { if (configuration) void action.run(async (signal) => { const value: unknown = JSON.parse(remoteDraft); if (!isJsonData(value)) throw new Error('远端内容须为合法 JSON 数据'); const result = await services.settings.saveRemote({ ...owner, section: remoteSection, value, expected_revision: configuration.revision, write_local_backup: backup }, signal); if (!signal.aborted) { setRemoteResult(result.data); onUpdated(result.data.revision === null ? null : { format_version: 1, revision: result.data.revision }); } return result; }); }}><CloudUpload />保存远端</Button>{remoteResult && <p className="capability-notice">实际来源：{remoteResult.source === 'remote' ? '远端服务' : '本地备份'} · 远端已提交：{remoteResult.remote_committed ? '是' : '否'} · 本地备份已更新：{remoteResult.backup_updated ? '是' : '否'}{remoteResult.revision === null ? '。请重新读取本地修订后继续写入。' : ''}</p>}
    </section><ActionFeedback {...action} /><JsonResult value={action.result} />
  </>;
}
