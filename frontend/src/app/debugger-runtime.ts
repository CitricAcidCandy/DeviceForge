import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext } from '../plugin-sdk/index.ts';
import { createDebuggerGateway } from '../services/api/index.ts';
import type { ApiClient } from '../services/api/index.ts';
import { createDebuggerBridge } from '../features/debugger/index.ts';
import { isJsonData } from '../shared/jobs/index.ts';
import { createLocalDebugger } from './debugger-local/index.ts';
import type { LocalDebuggerOptions } from './debugger-local/index.ts';
import { debuggerInputSchema, invokeDebuggerPublic } from './debugger-service.ts';
import type { DebuggerPublicOptions } from './debugger-service.ts';

export type RuntimeDebuggerOptions = Pick<LocalDebuggerOptions, 'document' | 'slots' | 'readHostRoutes' | 'navigate'>;
export function createRuntimeDebugger(options: RuntimeDebuggerOptions & {
  readonly client: ApiClient;
  readonly context: HostContext;
  readonly manager: LocalDebuggerOptions['manager'];
  readonly extensions: LocalDebuggerOptions['extensions'];
  readonly installation?: DebuggerPublicOptions['installation'];
  readonly reloadPlugin?: LocalDebuggerOptions['reloadPlugin'];
}) {
  const gateway = createDebuggerGateway(options.client);
  const local = createLocalDebugger({ document: options.document, signal: options.context.signal,
    closeSession: async sessionId => {
      await gateway.call({ name: 'deviceforge.debug_session', input: { action: 'close', session_id: sessionId } }, AbortSignal.timeout(2000));
    },
    manager: options.manager, extensions: options.extensions, ...(options.slots ? { slots: options.slots } : {}),
    ...(options.navigate ? { navigate: options.navigate } : {}),
    ...(options.readHostRoutes ? { readHostRoutes: options.readHostRoutes } : {}),
    ...(options.reloadPlugin ? { reloadPlugin: options.reloadPlugin } : {}) });
  const makeBridge = () => createDebuggerBridge({ gateway, signal: options.context.signal, directory: local.directory,
    select: local.select,
    async execute(command, signal) {
      if (!isJsonData(command.parameters)) throw new HostError('protocol', 'debugger_invalid_input', '调试命令参数不是有限 JSON');
      return local.execute(command.tool, { plugin_id: command.target.plugin_id,
        generation: command.target.generation ?? null }, command.parameters, signal);
    },
  });
  let bridge = makeBridge();
  let reconnecting: Promise<void> | null = null;
  function reconnect(): Promise<void> {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      await bridge.dispose();
      options.context.signal.throwIfAborted();
      bridge = makeBridge();
      await bridge.start();
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  }
  const release = options.extensions.register({ pluginId: 'host', generation: 0, context: options.context }, {
    services: [{ id: 'host.debugger', version: '1',
      inputSchema: debuggerInputSchema,
      outputSchema: {},
      async invoke(request, _context, signal) {
        return invokeDebuggerPublic({ context: options.context, client: options.client, gateway,
          start: () => bridge.start(), reconnect, snapshot: () => bridge.snapshot(),
          ...(options.installation ? { installation: options.installation } : {}) }, request, signal);
      },
    }],
  });
  let disposal: Promise<void> | null = null;
  return {
    attach: local.attach,
    observe: local.observe,
    start: () => bridge.start(),
    snapshot: () => bridge.snapshot(),
    dispose() {
      if (disposal) return disposal;
      release(); disposal = bridge.dispose(); local.dispose();
      return disposal;
    },
  };
}
