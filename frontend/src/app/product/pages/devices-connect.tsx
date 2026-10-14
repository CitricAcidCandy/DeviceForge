import { useEffect, useState } from 'react';
import { Button } from '../../../shared/ui/components/button.tsx';
import { Label } from '../../../shared/ui/components/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../shared/ui/components/select.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../shared/ui/components/dialog.tsx';
import type { DeviceProviderInfo } from '../../../plugin-sdk/index.ts';
import { ActionFeedback, EmptyState, Field, JsonResult } from '../common.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import type { ProductServices } from '../services.ts';
import { capabilityGate, decodeDeviceBusinessResult, executeDeviceTask } from './apps-contract.ts';
import type { DeviceBusinessResult } from './apps-contract.ts';

const providerKey = (provider: DeviceProviderInfo) => JSON.stringify([provider.id, provider.generation]);
interface DisconnectTarget {readonly provider: DeviceProviderInfo; readonly address: string}

export function DevicesConnect({services}: {services: ProductServices}) {
  const snapshot = useSnapshot(services.runtime.devices); const catalog = useSnapshot(services.runtime.operations); const action = useAction();
  const [selection, setSelection] = useState(''); const [address, setAddress] = useState('');
  const [confirmation, setConfirmation] = useState<DisconnectTarget | null>(null);
  const [report, setReport] = useState<{key: string; title: string; data: DeviceBusinessResult} | null>(null);
  const provider = snapshot.providers.find(item => providerKey(item) === selection) ?? null;
  const key = provider ? providerKey(provider) : ''; const operations = catalog.pending ? [] : catalog.result?.data ?? [];
  const connect = capabilityGate(snapshot, operations, 'connect', provider);
  const disconnect = capabilityGate(snapshot, operations, 'disconnect', provider);
  const confirmationGate = confirmation ? capabilityGate(snapshot, operations, 'disconnect', confirmation.provider) : null;
  useEffect(() => {action.cancel(); setReport(null); setConfirmation(null);}, [key, action.cancel]);
  const run = (id: 'connect' | 'disconnect', target: DeviceProviderInfo, targetAddress: string) => {
    const gate = capabilityGate(services.runtime.devices.snapshot(), operations, id, target); if (!gate.capability) return;
    void action.run(async signal => {
      const response = await executeDeviceTask(services, id, {providerId: target.id, generation: target.generation,
        deviceId: null, capability: gate.capability?.id ?? id, version: 1, input: {address: targetAddress}}, signal, decodeDeviceBusinessResult);
      if (!signal.aborted && services.runtime.devices.snapshot().providers.some(item => providerKey(item) === providerKey(target))) setReport({key: providerKey(target), title: id === 'connect' ? '连接任务完成' : '断开任务完成', data: response.data});
      return response;
    });
  };
  return <div className="workspace-section" data-product-section="devices-connect"><h2>连接设备提供者</h2><p className="muted">提供者连接能力不依赖已有设备目录。连接后在提供者列表重新发现设备；地址格式由所选提供者校验。</p>
    {snapshot.providers.length ? <><fieldset disabled={action.pending} className="form-grid"><div className="form-field"><Label>连接提供者</Label><Select value={provider ? selection : ''} onValueChange={setSelection}><SelectTrigger aria-label="连接提供者"><SelectValue placeholder="选择当前运行提供者" /></SelectTrigger><SelectContent>{snapshot.providers.map(item => <SelectItem value={providerKey(item)} key={providerKey(item)}>{item.id} · {item.definition.platform} · {item.generation}</SelectItem>)}</SelectContent></Select></div><Field label="设备连接地址" value={address} onChange={setAddress} placeholder="填写所选提供者支持的真实地址" /></fieldset><div className="page-actions"><Button disabled={!provider || !address.trim() || !connect.capability || action.pending} title={connect.reason ?? undefined} onClick={() => {if (provider) run('connect', provider, address.trim());}}>连接地址</Button><Button variant="outline" disabled={!provider || !address.trim() || !disconnect.capability || action.pending} title={disconnect.reason ?? undefined} onClick={() => {if (provider) setConfirmation({provider, address: address.trim()});}}>断开地址</Button></div>
      {provider && connect.reason && <p className="capability-notice">连接：{connect.reason}</p>}{provider && disconnect.reason && <p className="capability-notice">断开：{disconnect.reason}</p>}</> : <EmptyState title="没有运行中的设备提供者" description="先加载支持设备能力的服务器插件并刷新目录。" />}
    <ActionFeedback {...action} />{report?.key === key && <div className="result-row"><h3>{report.title}</h3><p className="muted">重新发现设备以取得当前观测；任务成功不代表旧目录已经刷新。</p><JsonResult value={report.data.result} /></div>}
    <Dialog open={confirmation !== null} onOpenChange={open => {if (!open) setConfirmation(null);}}><DialogContent><DialogHeader><DialogTitle>断开设备地址？</DialogTitle><DialogDescription>提供者 {confirmation?.provider.id} / {confirmation?.provider.generation}，地址 {confirmation?.address}。该地址的连接会被断开；取消等待不能证明连接仍保持。</DialogDescription></DialogHeader>{confirmationGate?.reason && <p className="capability-notice">{confirmationGate.reason}</p>}<DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>保持连接</Button><Button variant="destructive" disabled={!confirmationGate?.capability || action.pending || confirmation !== null && providerKey(confirmation.provider) !== key} onClick={() => {const target = confirmation; if (target) {setConfirmation(null); run('disconnect', target.provider, target.address);}}}>确认断开</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
