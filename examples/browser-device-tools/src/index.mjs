import { createContributions } from './contributions.mjs';
import { createSession } from './session.mjs';

export const id = 'browser_device_tools';
export const configuration = {
  version: 1, apply_policy: 'next_invocation',
  schema: { type: 'object', additionalProperties: false, required: ['rememberedJobs', 'publishEvents'], properties: {
    rememberedJobs: { type: 'integer', title: '保留任务数量', description: '本代插件保留的任务标识上限。', minimum: 1, maximum: 128 },
    publishEvents: { type: 'boolean', title: '发布目录变化事件' },
  } },
  defaults: { rememberedJobs: 32, publishEvents: true },
};
let activationSequence = 0;

// 这里只生成本地观测标记，不承担鉴权或服务器代次；普通 LAN HTTP 也能激活。
function nextRunId() {
  return 'activation-' + Date.now().toString(36) + '-' + (++activationSequence).toString(36)
    + '-' + Math.random().toString(36).slice(2);
}

// 无宿主源码导入、运行依赖、页面或工具路径；宿主通过公开上下文提供能力。
export async function activateExample(context, runId = nextRunId()) {
  context.signal.throwIfAborted();
  if (context.apiVersion !== 2 || typeof context.extensions?.register !== 'function') {
    throw new Error('此示例需要 SDK v2 的公开动态贡献注册扩展');
  }
  const session = createSession(context, id, runId);
  context.onDispose(session.close);
  try {
    session.track(context.subscribeOperations(session.observeOperations));
    if (context.devices) session.track(context.devices.subscribe(session.observeDevices));
    session.track(context.extensions.register(createContributions(id, session)));
    const revision = session.operationRevision();
    const reply = await context.listOperations(context.signal);
    context.signal.throwIfAborted();
    session.seedOperations(reply.data, revision);
    return session;
  } catch (error) {
    try { await session.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], '示例激活失败且清理失败'); }
    throw error;
  }
}

export default {
  id, version: '0.1.0', apiVersion: 2, panels: [], configuration,
  async activate(context) { await activateExample(context); },
};
