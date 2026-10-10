import { dependencyRun } from './relative.js';

const id = 'ordinary_deadline_browser_probe';
const key = Symbol.for('deviceforge.ordinary-deadline-browser.probe');
const response = await fetch(new URL('./settings.json', import.meta.url));
if (!response.ok) throw new Error('本次浏览器包配置不可读');
const settings = await response.json();
const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
  signal.addEventListener('abort', cancel, { once: true });
});

export default {
  id, version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context) {
    const probe = { context, dependencyRun, closed: false, notifications: [] };
    globalThis[key] = probe;
    context.onDispose(() => { probe.closed = true; });
    context.subscribeOperations((operations) => {
      probe.notifications.push(operations.map((entry) => ({ id: entry.id,
        ...(entry.execution === undefined ? {} : { execution: entry.execution }) })));
    });
  },
  contributions: { commands: [
    { id: id + '.inspect', title: '读取普通执行预算', async execute(_input, context, signal) {
      const reply = await context.listOperations(signal);
      return { data: { apiVersion: context.apiVersion, dependencyRun,
        operations: reply.data.map((entry) => ({ id: entry.id,
          ...(entry.execution === undefined ? {} : { execution: entry.execution }) })) }, logId: reply.logId };
    } },
    { id: id + '.submit-default', title: '有限普通任务消费', async execute(input, context, signal) {
      const fixture = settings.fixtures.find((entry) => entry.pluginId === input.pluginId);
      if (!fixture || typeof input.caseId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.caseId)) {
        throw new Error('本次 default 调用身份非法');
      }
      // 只提交冻结业务字段，不传执行预算、控制根或私有封套。
      const accepted = await context.submit(fixture.operations.default, { case_id: input.caseId }, signal);
      const logs = [{ phase: 'submit', logId: accepted.logId }];
      const deadline = performance.now() + 8000;
      let completed;
      while (true) {
        const reply = await context.getJob(accepted.data.id, signal);
        logs.push({ phase: 'getJob', logId: reply.logId });
        if (['succeeded', 'failed', 'cancelled'].includes(reply.data.status)) { completed = reply; break; }
        if (performance.now() >= deadline) throw new Error('本次有限 default 任务未在 8 秒内进入终态');
        await pause(50, signal);
      }
      if (completed.data.status !== 'succeeded') throw new Error('真实 default 任务失败：' + completed.data.error);
      return { data: { accepted: accepted.data, job: completed.data, logs }, logId: completed.logId };
    } },
  ] },
};
