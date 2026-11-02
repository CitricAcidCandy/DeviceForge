import type { HostContext } from '@deviceforge/plugin-sdk';
import { createOperationSource, createPublicGateway } from '@deviceforge/business-kit/platform';
import { createAutomation } from './model/index.ts';

export function createAutomationServices(context: HostContext) {
  const devices = context.devices, artifacts = context.artifacts;
  if (!devices || !artifacts) throw new Error('自动化工作区需要公开设备和产物能力');
  const operations = createOperationSource(context);
  const automation = createAutomation(createPublicGateway(context), { operations }, artifacts);
  return {
    context, devices, operations, automation,
    dispose() { operations.dispose(); automation.dispose(); },
  };
}
export type AutomationServices = ReturnType<typeof createAutomationServices>;
