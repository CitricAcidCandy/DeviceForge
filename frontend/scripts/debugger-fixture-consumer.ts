import type { HostContext, JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';

// 消费者与提供者没有源码依赖，组合调用只通过公开服务 ID 和精确版本。
async function consume(input: JsonValue, context: HostContext, signal: AbortSignal) {
  if (!context.extensions) throw new Error('宿主缺少公开扩展接口');
  return context.extensions.callService('acceptance.debug-provider.echo', '1', input, signal);
}
const id = 'acceptance.debug-consumer';
const plugin: WebPlugin = {
  id, version: '1.0.0', apiVersion: 2,
  panels: [{ id: `${id}.panel`, title: '受控消费者面板', async mount(target, context) {
    const node = target.ownerDocument.createElement('button'); node.type = 'button'; node.textContent = '消费回显服务';
    node.dataset.deviceforgeAction = 'local';
    const click = () => { void consume({ message: '独立消费者', value: 42 }, context, context.signal)
      .then((result) => { node.dataset.jobResult = JSON.stringify(result); }, (error: unknown) => { node.dataset.error = String(error); }); };
    node.addEventListener('click', click); target.append(node);
    return () => { node.removeEventListener('click', click); node.remove(); };
  } }],
  contributions: { commands: [{ id: `${id}.consume`, title: '独立消费公开服务', execute: consume }] },
};
export default plugin;
