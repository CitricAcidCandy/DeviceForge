import { withPluginRelease } from '../services/api/index.ts';
import type { ApiClient, PluginReleaseReference } from '../services/api/index.ts';
import type { HostContext } from '../plugin-sdk/index.ts';
import type { Tasks } from '../features/tasks/index.ts';
import type { Devices } from '../features/devices/index.ts';
import { createDeviceGateway } from './device-gateway.ts';
import { publicCall, publicJob } from './public-api.ts';
import { createPluginTransport } from './plugin-transport.ts';
import { createPluginCleanup } from './plugin-cleanup.ts';
import { scopedTransportAccess } from '../plugins/transport-access.ts';

export function createReleaseHost(context: HostContext, client: ApiClient,
  release: PluginReleaseReference, tasks: Tasks, devices: Devices, cleanupMs?: number): HostContext {
  const scopedClient = withPluginRelease(client, release);
  const transport = createPluginTransport(scopedClient);
  const gateway = createDeviceGateway(scopedClient, context.signal);
  return {
    ...context,
    transport: scopedTransportAccess(transport, context.signal, context.onDispose),
    onCleanup: createPluginCleanup({
      signal: context.signal, onDispose: context.onDispose, transport,
      ...(cleanupMs === undefined ? {} : { timeoutMs: cleanupMs }),
    }),
    submit: (operation, input, signal) => publicCall(
      tasks.submit({ operation, input }, signal, scopedClient), publicJob,
    ),
    getJob: (id, signal) => publicCall(tasks.get(id, signal, scopedClient), publicJob),
    cancelJob: (id, signal) => publicCall(tasks.cancel(id, signal, scopedClient), publicJob),
    ...(context.devices ? { devices: {
      ...context.devices,
      refreshProviders: (signal) => devices.refreshProviders(signal, gateway),
      refreshDirectories: (signal) => devices.refreshDirectories(signal, gateway),
      refreshProvider: (id, generation, signal) => devices.refreshProvider(id, generation, signal, gateway),
      invoke: (action, signal) => devices.invoke(action, signal, gateway),
    } } : {}),
  };
}
