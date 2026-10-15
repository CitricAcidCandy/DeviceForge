import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/product/App.tsx';
import { createProductServices } from '../../src/app/product/services.ts';
import type { ProductServices } from '../../src/app/product/services.ts';
import '../../src/app/styles.css';
import { createDeviceWorkspaceFixture } from './fixture.ts';

const fixture = createDeviceWorkspaceFixture();
let services: ProductServices | null = null;
let root: ReturnType<typeof createRoot> | null = null;
export async function mount() {
  const target = document.createElement('div');
  target.id = 'device-workspace-fixture-root';
  document.body.append(target);
  services = createProductServices({
    baseUrl: location.origin,
    transport: fixture.transport,
    panelTarget: () => target,
  });
  root = createRoot(target);
  root.render(createElement(App, { services }));
  return { scope: '受控 API 与真实生产组件 DOM；不含 Rust 或真机' };
}
export function requests() {
  return fixture.requests;
}
export function selected() {
  return services?.runtime.devices.snapshot().selected ?? null;
}
export async function refreshOperations(missing: boolean) {
  fixture.setMissingOperations(missing);
  await services?.runtime.operations.refresh(AbortSignal.timeout(10000));
}
export function failDiscovery(fail: boolean) {
  fixture.setDiscoveryFailure(fail);
}
export function holdDiscovery(hold: boolean) {
  fixture.holdDiscovery(hold);
}
export function releaseDiscovery() {
  fixture.releaseDiscovery();
}
export function pendingDiscovery() {
  return fixture.pendingDiscovery();
}
export function messages() {
  return services?.messages.snapshot() ?? [];
}
export function clearMessages() {
  services?.messages.clear();
}
export function publishMessage(title: string) {
  return services?.messages.info(title, { id: 'route-message-probe' });
}
export async function disposeWithLateDiscovery() {
  const previous = services?.messages;
  await dispose();
  fixture.releaseDiscovery();
  await new Promise<void>((done) => setTimeout(done, 150));
  previous?.success('已销毁实例不应显示的消息');
  return { messages: previous?.snapshot() ?? [], pending: fixture.pendingDiscovery() };
}
export async function dispose() {
  root?.unmount();
  root = null;
  await services?.dispose();
  services = null;
  fixture.releaseDiscovery();
}
