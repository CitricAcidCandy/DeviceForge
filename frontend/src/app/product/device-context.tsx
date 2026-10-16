import { Smartphone } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import type { ProductServices } from './services.ts';
import { useSnapshot } from './hooks.ts';
import './device-context.css';

export function DeviceContext({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const available = snapshot.directories.flatMap((directory) => directory.devices);
  const selectedKey = snapshot.selection ? JSON.stringify(snapshot.selection) : 'none';
  const selected = available.find((device) => JSON.stringify(device.reference) === selectedKey);
  const selectedLabel = selected ? `${selected.model ?? selected.reference.localId} · ${selected.state === 'online' ? '在线' : selected.state === 'unauthorized' ? '待授权' : selected.state === 'offline' ? '离线' : '状态未知'}` : '尚未选择设备';
  return (
    <div className="device-context" aria-label="当前工作设备">
      <span className="device-context-label"><Smartphone aria-hidden="true" />工作设备</span>
      <Select
        value={selectedKey}
        onValueChange={(key) => {
          const chosen = available.find((device) => JSON.stringify(device.reference) === key);
          services.runtime.devices.select(chosen?.reference ?? null);
        }}
      >
        <SelectTrigger aria-label="选择当前设备"><SelectValue placeholder="选择设备">{selectedLabel}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">尚未选择设备</SelectItem>
          {available.map((device) => (
            <SelectItem key={JSON.stringify(device.reference)} value={JSON.stringify(device.reference)}>
              {device.model ?? device.reference.localId} · {device.state === 'online' ? '在线' : device.state === 'unauthorized' ? '待授权' : device.state === 'offline' ? '离线' : '状态未知'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <a href="#devices">设备目录</a>
    </div>
  );
}
