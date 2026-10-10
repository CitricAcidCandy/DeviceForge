import { dependencyRun } from './relative.js';

const id = 'raw_browser_probe';
const key = Symbol.for('deviceforge.unified-discovery-browser.probe');

export default {
  id, version: '1.0.0', apiVersion: 2,
  async activate(context) {
    if (!context.devices) throw new Error('公开宿主缺少设备能力');
    // 仅独立验收页使用此有界通道，不增加生产宿主接口或依赖私有模块。
    const probe = { context, dependencyRun, notifications: 0, writes: 0, snapshots: [], closed: false };
    globalThis[key] = probe;
    context.devices.subscribe((snapshot) => {
      ++probe.notifications;
      probe.snapshots.push(snapshot); if (probe.snapshots.length > 32) probe.snapshots.shift();
    });
    context.onDispose(() => { probe.closed = true; });
  },
  panels: [{ id: `${id}.panel`, title: '原始观测验收挂载', async mount(root, context) {
    const text = root.ownerDocument.createElement('pre'); root.append(text);
    const release = context.devices.subscribe((snapshot) => {
      text.textContent = snapshot.directories.flatMap((entry) => entry.devices.map((device) => device.rawState ?? '未提供')).join('\n');
    });
    return async () => { await release(); text.remove(); };
  } }],
  contributions: { commands: [{ id: `${id}.refresh`, title: '公开设备刷新', async execute(input, context, signal) {
    const reply = await context.devices.refreshProviders(signal);
    const provider = reply.data.find((entry) => entry.id === 'raw_browser_provider');
    if (!provider) throw new Error('验收提供者未加载');
    const result = await context.devices.refreshProvider(provider.id, provider.generation, signal);
    const probe = globalThis[key]; if (probe?.context === context) ++probe.writes;
    return { data: { jobId: result.data.discoveryJobId, generation: result.data.provider.generation }, logId: result.logId };
  } }] },
};
