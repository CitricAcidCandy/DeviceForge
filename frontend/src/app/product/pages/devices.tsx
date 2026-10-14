import { RefreshCw, Smartphone, Check, ArrowUpRight, PlugZap } from 'lucide-react';
import { Button } from '../../../shared/ui/components/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../shared/ui/components/table.tsx';
import type { ProductServices } from '../services.ts';
import { useAction, useSnapshot } from '../hooks.ts';
import { ActionFeedback, EmptyState, JsonResult, PageTitle } from '../common.tsx';
import { DevicesConnect } from './devices-connect.tsx';

const deviceStates = { online: '在线', offline: '离线', unauthorized: '等待设备授权', unknown: '状态未知' };
export function DevicesPage({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const refresh = useAction();
  const action = useAction();
  const selected = snapshot.selected;
  const selectedProvider = snapshot.providers.find((provider) => provider.id === selected?.reference.providerId && provider.generation === selected.reference.generation);
  const packageCapability = selectedProvider?.definition.capabilities.find((capability) => capability.id === 'packages' && capability.scope === 'device');
  const packageAvailability = selected?.capabilities.find((capability) => capability.id === packageCapability?.id && capability.version === packageCapability.version);
  const directories = snapshot.directories;
  return <div className="product-page">
    <PageTitle eyebrow="WORKSHOP / DEVICES" title="设备工作台" description="连接你的设备，从一次清晰的操作开始。"><Button disabled={refresh.pending} onClick={() => { void refresh.run(services.runtime.devices.refreshDirectories); }}><RefreshCw />刷新设备</Button></PageTitle>
    <ActionFeedback {...refresh} />
    <DevicesConnect services={services} />
    {snapshot.providers.length === 0 ? <EmptyState title="还没有可用的设备提供者" description="在插件页加载设备插件，再刷新设备目录。服务器连接失败时，请先重新连接。" /> : <div className="provider-strip">{snapshot.providers.map((provider) => <div key={`${provider.id}:${provider.generation}`}><PlugZap aria-hidden="true" /><span>{provider.definition.platform}<small>{provider.id} · {provider.version}</small></span><Button variant="ghost" size="sm" disabled={refresh.pending} onClick={() => { void refresh.run((signal) => services.runtime.devices.refreshProvider(provider.id, provider.generation, signal)); }}>重新发现</Button></div>)}</div>}
    {snapshot.providers.length > 0 && directories.every((directory) => directory.devices.length === 0) && <EmptyState title="没有发现设备" description="检查数据线、网络连接和设备授权，然后重新发现。支持的连接方式由设备提供者决定。" />}
    {directories.some((directory) => directory.devices.length > 0) && <Table><TableHeader><TableRow><TableHead>设备</TableHead><TableHead>来源</TableHead><TableHead>状态</TableHead><TableHead className="text-right">工作对象</TableHead></TableRow></TableHeader><TableBody>{directories.flatMap((directory) => directory.devices.map((device) => {
      const current = JSON.stringify(snapshot.selection) === JSON.stringify(device.reference);
      return <TableRow key={JSON.stringify(device.reference)} data-selected={current}><TableCell><span className="device-name"><Smartphone aria-hidden="true" />{device.model ?? device.reference.localId}</span><small className="muted mono">{device.reference.localId}</small></TableCell><TableCell>{directory.provider.definition.platform}<small className="muted">{directory.provider.id}</small></TableCell><TableCell><span className={`text-state state-${device.state}`}>{deviceStates[device.state]}</span>{device.rawState && <small className="muted">{device.rawState}</small>}</TableCell><TableCell className="text-right"><Button size="sm" variant={current ? 'secondary' : 'outline'} onClick={() => services.runtime.devices.select(device.reference)}>{current && <Check />}{current ? '当前设备' : '选择设备'}</Button></TableCell></TableRow>;
    }))}</TableBody></Table>}
    {selected && <section className="selected-device-section"><div className="section-heading"><div><h2>{selected.model ?? selected.reference.localId}</h2><p className="muted">当前工作对象 · {selectedProvider?.definition.platform} · {deviceStates[selected.state]}</p></div><Button variant="ghost" onClick={() => services.runtime.devices.select(null)}>取消选择</Button></div>
      <div className="quick-links">{[{ id: 'packages', label: '应用与包' }, { id: 'files', label: '文件与产物' }, { id: 'media', label: '画面与录制' }, { id: 'performance', label: '性能与调用栈' }, { id: 'terminal', label: '终端' }].map((entry) => <Button key={entry.id} variant="outline" asChild><a href={`#${entry.id}`}>{entry.label}<ArrowUpRight /></a></Button>)}</div>
      {packageCapability && <div className="inline-action"><Button variant="secondary" disabled={action.pending || selected.state !== 'online' || !packageAvailability?.available} onClick={() => { void action.run((signal) => services.runtime.devices.invoke({ providerId: selected.reference.providerId, generation: selected.reference.generation, deviceId: selected.reference.localId, capability: packageCapability.id, version: packageCapability.version, input: {} }, signal)); }}>读取应用列表任务</Button><span className="muted">{packageAvailability?.available ? '结果及任务进度可在任务页查看' : packageAvailability?.reason ?? '此设备暂未提供应用列表能力'}</span></div>}
      <ActionFeedback {...action} /><JsonResult value={action.result} />
      <details className="capability-details"><summary>设备能力与来源</summary><Table><TableHeader><TableRow><TableHead>能力</TableHead><TableHead>版本</TableHead><TableHead>可用状态</TableHead></TableRow></TableHeader><TableBody>{selected.capabilities.map((capability) => <TableRow key={`${capability.id}:${capability.version}`}><TableCell className="mono">{capability.id}</TableCell><TableCell>{capability.version}</TableCell><TableCell>{capability.available ? '可用' : capability.reason ?? '当前不可用'}</TableCell></TableRow>)}</TableBody></Table></details>
    </section>}
  </div>;
}
