// 真实在线安装的第三方消费者，只调用公开 SDK，不获得 runtime 或测试控制桥。
const id = 'browser_device_tools_consumer';
export default {
  id, version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context) {
    let eventCount = 0; let lastGeneration = null;
    const extensions = context.extensions;
    if (!extensions?.register) throw new Error('消费者需要公开动态贡献接口');
    extensions.subscribeEvent('browser_device_tools.changed', (event) => {
      ++eventCount; lastGeneration = event.generation;
    });
    extensions.register({ commands: [
      { id: id + '.call', title: '跨插件调用示例公开服务', async execute(input, current, signal) {
        if (input?.method === 'catalog') return current.extensions.callService(
          'browser_device_tools.catalog-service', '1.0.0', {}, signal);
        if (input?.method === 'history' && typeof input.jobId === 'string') return current.extensions.callService(
          'browser_device_tools.history-service', '1.0.0', { jobId: input.jobId }, signal);
        throw new Error('消费者只接受明确的目录或历史服务调用');
      } },
      { id: id + '.events', title: '读取本消费者已收到的公开事件计数', async execute(_input, _current, signal) {
        signal.throwIfAborted();
        return { data: { eventCount, lastGeneration }, logId: null };
      } },
    ] });
  },
};
