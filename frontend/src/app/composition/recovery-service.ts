import type { HostContext } from '../../plugin-sdk/index.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import type { RecoveryState } from './recovery-state.ts';

export function registerRecoveryService(
  registry: ExtensionRegistry, context: HostContext, recovery: RecoveryState,
) {
  return registry.register({ pluginId: 'host', generation: 0, context }, { services: [{
    id: 'host.platform.recovery', version: '1',
    inputSchema: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: { action: { type: 'string', enum: ['open', 'close', 'status'] } },
    },
    async invoke(input) {
      if (input && typeof input === 'object' && !Array.isArray(input) && 'action' in input) {
        if (input.action === 'open') recovery.open();
        else if (input.action === 'close') recovery.close();
      }
      return { data: { open: recovery.snapshot().open }, logId: null };
    },
  }] });
}
