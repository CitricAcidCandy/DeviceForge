import { Smartphone } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import type { ProductServices } from './services.ts';
import { useSnapshot } from './hooks.ts';
import './device-context.css';

const stateText: Record<string, string> = {
  online: '在线',
  offline: '离线',
  unauthorized: '待授权',
  unknown: '状态未知',
};

export function DeviceContext({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const available = snapshot.directories.flatMap((directory) => directory.devices);
  const selectedKey = snapshot.selection ? JSON.stringify(snapshot.selection) : 'none';
  const selected = available.find((device) => JSON.stringify(device.reference) === selectedKey);
  const state = selected?.state ?? 'unknown';
  const selectedLabel = selected
    ? `${selected.model ?? selected.reference.localId} · ${stateText[state] ?? state}`
    : '选择设备';
  return (
    <div className="device-context" data-empty={selected ? 'false' : 'true'} aria-label="当前工作设备">
      <Smartphone className="device-context-icon" aria-hidden="true" />
      <Select
        value={selectedKey}
        onValueChange={(key) => {
          const chosen = available.find((device) => JSON.stringify(device.reference) === key);
          services.runtime.devices.select(chosen?.reference ?? null);
        }}
      >
        <SelectTrigger aria-label="选择当前设备">
          {selected && <span className="device-context-dot" data-state={state} aria-hidden="true" />}
          <SelectValue placeholder="选择设备">{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">尚未选择设备</SelectItem>
          {available.map((device) => (
            <SelectItem key={JSON.stringify(device.reference)} value={JSON.stringify(device.reference)}>
              {device.model ?? device.reference.localId} · {stateText[device.state] ?? device.state}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
