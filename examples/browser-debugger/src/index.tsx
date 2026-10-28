import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { WebPlugin } from '../../../frontend/src/plugin-sdk/index.ts';
import { DebuggerApp } from './view.tsx';
import { createDebuggerController } from './controller.ts';
import { array, object, text } from './protocol.ts';

const plugin: WebPlugin = {
  id: 'deviceforge_debugger', version: '0.1.0', apiVersion: 2, panels: [],
  contributions: { components: [{
    id: 'deviceforge_debugger.floating', title: 'DeviceForge 调试器', slot: 'developer.tools', mode: 'append',
    async mount(target, context) {
      const element = target.ownerDocument.createElement('div');
      element.setAttribute('data-deviceforge-debugger', '');
      element.setAttribute('data-deviceforge-debugger-internal', '');
      target.append(element);
      const controller = createDebuggerController(context);
      const root = createRoot(element);
      root.render(<DebuggerApp controller={controller} context={context} />);
      const unsubscribe = context.extensions?.subscribeEvent('host.debugger.target_requested', (event) => {
        const data = object(event.data);
        const raw = Array.isArray(data.candidates) ? array(data.candidates) : [data];
        const candidates = raw.map((item) => ({ kind: text(object(item).target_kind), pluginId: text(object(item).plugin_id) }))
          .filter((item) => (item.kind === 'browser' || item.kind === 'server') && item.pluginId);
        void controller.requestTargets(candidates, text(data.installation_id) || null);
      });
      let released = false;
      const dispose = async () => {
        if (released) return;
        released = true; unsubscribe?.(); root.unmount(); element.remove(); await controller.dispose();
      };
      const release = context.onDispose(dispose);
      return async () => { await release(); };
    },
  }] },
};
export default plugin;
