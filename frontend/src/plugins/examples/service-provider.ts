import type { WebPlugin } from '../../plugin-sdk/index.ts';

// 独立提供者只声明公开契约，不导入消费者或宿主实现。
const plugin: WebPlugin = {
  id: 'example.service-provider', version: '1.0.0', apiVersion: 2, panels: [],
  contributions: { services: [{
    id: 'example.service-provider.echo', version: '1',
    inputSchema: { type: 'string', maxLength: 256 },
    outputSchema: { type: 'string', maxLength: 256 },
    invoke: async (input) => ({ data: input, logId: null }),
  }] },
};
export default plugin;
