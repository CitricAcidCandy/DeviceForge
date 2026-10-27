import type { HostContext, TypedService, WebPlugin } from '../../plugin-sdk/index.ts';

const echo: TypedService<string, string> = {
  id: 'example.service-provider.echo', version: '1',
  accepts: (value): value is string => typeof value === 'string' && value.length <= 256,
  returns: (value): value is string => typeof value === 'string' && value.length <= 256,
};
function mount(target: HTMLElement, context: HostContext) {
  const button = target.ownerDocument.createElement('button');
  button.type = 'button'; button.textContent = '调用组合服务';
  const status = target.ownerDocument.createElement('output');
  const click = () => {
    const service = context.services;
    if (!service) return;
    button.disabled = true;
    void service.callTyped(echo, '组合服务已就绪', context.signal).then((reply) => {
      if (!context.signal.aborted) status.textContent = reply.data;
    }).catch((error: unknown) => {
      if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : '服务调用失败';
    }).finally(() => { if (!context.signal.aborted) button.disabled = false; });
  };
  button.addEventListener('click', click);
  target.append(button, status);
  return Promise.resolve(() => { button.removeEventListener('click', click); button.remove(); status.remove(); });
}
const plugin: WebPlugin = {
  id: 'example.service-consumer', version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context) {
    if (!context.services) throw new Error('当前宿主未提供功能级服务依赖入口');
    context.services.whenAvailable('echo-workspace', [echo], async (feature) => {
      const register = feature.extensions?.register;
      if (!register) throw new Error('当前宿主未提供公开动态注册入口');
      register({
        modules: [{ id: 'example.service-consumer.page', title: '组合服务', route: '/catalog', mount }],
        components: [{ id: 'example.service-consumer.widget', title: '组合服务', slot: 'workspace.sidebar', mount }],
        commands: [{ id: 'example.service-consumer.echo', title: '组合调用',
          execute: async (_input, callContext, signal) => {
            if (!callContext.services) throw new Error('服务调用上下文已撤销');
            return callContext.services.callTyped(echo, '组合服务已就绪', signal);
          } }],
      });
    });
  },
};
export default plugin;
