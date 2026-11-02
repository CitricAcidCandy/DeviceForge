import type { HostContext } from '@deviceforge/plugin-sdk';
import { createOperationSource, createPublicGateway } from '@deviceforge/business-kit/platform';
import { createFrida } from './model/index.ts';

export function createFridaServices(context: HostContext) {
  const devices = context.devices, artifacts = context.artifacts;
  if (!devices || !artifacts) throw new Error('Frida 工作区需要公开设备和产物能力');
  const operations = createOperationSource(context);
  const frida = createFrida(createPublicGateway(context), artifacts, { operations });
  return {
    context, devices, operations, frida,
    dispose() { operations.dispose(); frida.dispose(); },
  };
}
export type FridaServices = ReturnType<typeof createFridaServices>;
