import type { HostContext, HostResult, JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';

// 此独立插件只消费公开 SDK 类型；转译后的包不含宿主源码路径或运行时导入。
const id = 'acceptance.debug-provider';
let mountSequence = 0;
async function mount(target: HTMLElement, context: HostContext) {
  const mountId = `${id}.mount-${++mountSequence}`;
  const document = target.ownerDocument;
  const content = document.createElement('section');
  content.setAttribute('aria-label', '受控提供者');
  const count = document.createElement('output'); count.setAttribute('aria-label', '计数0');
  let clicks = 0;
  const button = (name: string, policy: string, disabled = false) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = name;
    node.dataset.deviceforgeAction = policy; node.disabled = disabled;
    node.addEventListener('click', () => { clicks++; count.textContent = String(clicks); count.setAttribute('aria-label', `计数${clicks}`); });
    content.append(node); return node;
  };
  button('本地计数', 'local'); button('禁用动作', 'local', true); button('设备动作', 'device');
  button('只读动作', 'read-only'); button('未知动作', 'unknown');
  const input = document.createElement('input'); input.setAttribute('aria-label', '受控文本'); input.dataset.deviceforgeAction = 'local';
  const secret = document.createElement('input'); secret.type = 'password'; secret.value = '仅供检查脱敏的合成口令';
  secret.setAttribute('aria-label', '合成口令');
  content.append(input, secret, count); target.append(content);
  const debug = context.debug?.registerNode({ id: `${mountId}.semantic`, role: 'fixture', label: '独立公开语义节点' });
  context.debug?.emit({ name: '挂载前未选事件' });
  const timer = setInterval(() => context.debug?.emit({ name: '受控心跳' }), 100);
  const releaseTimer = context.debug?.registerResource({ id: `${mountId}.timer`, kind: 'timer', label: '受控事件定时器' }, () => clearInterval(timer));
  let closed = false;
  const dispose = async () => {
    if (closed) return; closed = true; clearInterval(timer); await releaseTimer?.(); debug?.dispose(); content.remove();
  };
  const release = context.onDispose(dispose);
  return async () => { await release(); };
}
async function echo(input: JsonValue, context: HostContext, signal: AbortSignal): Promise<HostResult<JsonValue>> {
  // 唯一后端业务是本次安装的纯回显夹具，原提交结果及日志 ID 原样关联。
  const original = await context.submit('plugin.online_echo_v2.echo', input, signal);
  let job = original.data;
  for (let attempt = 0; (job.status === 'queued' || job.status === 'running') && attempt < 100; attempt++) {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    job = (await context.getJob(job.id, signal)).data;
  }
  if (job.status !== 'succeeded') throw new Error('本次回显任务未成功终态');
  return { data: { job: { ...job }, submission_log_id: original.logId }, logId: original.logId };
}
const plugin: WebPlugin = {
  id, version: '1.0.0', apiVersion: 2,
  panels: [{ id: `${id}.panel`, title: '受控提供者面板', mount }],
  contributions: {
    components: [
      { id: `${id}.append`, title: '受控追加', slot: 'debugger.fixture.append', mode: 'append', mount },
      { id: `${id}.replace`, title: '受控替换', slot: 'debugger.fixture.replace', mode: 'replace', mount },
    ],
    modules: [{ id: `${id}.page`, title: '受控页面', route: '/debugger-fixture', mount }],
    services: [{ id: `${id}.echo`, version: '1',
      inputSchema: { type: 'object', required: ['message', 'value'], additionalProperties: false,
        properties: { message: { type: 'string' }, value: { type: 'integer' } } },
      outputSchema: { type: 'object' }, invoke: echo }],
  },
};
export default plugin;
