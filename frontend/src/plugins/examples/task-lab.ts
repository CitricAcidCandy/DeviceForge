import type { WebPlugin } from '../../plugin-sdk/index.ts';

// 可作为独立包入口导出；这里只依赖公开 SDK，不创建宿主页面。
export function createTaskLab(operationId: string): WebPlugin {
  return {
    id: 'task-lab',
    version: '1.0.0',
    apiVersion: 2,
    panels: [],
    contributions: {
      components: [
        {
          id: 'task-lab.status',
          title: '任务实验状态',
          slot: 'workspace.sidebar',
          async mount(target, host) {
            target.textContent = '任务实验扩展已运行';
            const release = host.subscribeOperations((operations) => {
              target.textContent = `公开操作：${operations.length}`;
            });
            return release;
          },
        },
      ],
      modules: [
        {
          id: 'task-lab.module',
          title: '任务实验模块',
          route: '/task-lab',
          async mount(target) {
            target.textContent = '通过 task-lab.submit 命令提交公开任务';
            return () => {
              target.textContent = '';
            };
          },
        },
      ],
      commands: [
        {
          id: 'task-lab.submit',
          title: '提交实验任务',
          async execute(input, host, signal) {
            const result = await host.submit(operationId, input, signal);
            host.extensions?.emitEvent('task-lab.submitted', { id: result.data.id });
            return {
              data: { id: result.data.id, status: result.data.status },
              logId: result.logId,
            };
          },
        },
      ],
      services: [
        {
          id: 'task-lab.echo',
          version: '1',
          async invoke(input) {
            return { data: input, logId: null };
          },
        },
      ],
      beforeTaskSubmit: [
        {
          id: 'task-lab.input',
          priority: 0,
          async transform(submission) {
            return submission.operation === operationId
              ? { ...submission, input: { source: 'task-lab', value: submission.input } }
              : submission;
          },
        },
      ],
    },
    async activate(host) {
      host.extensions?.setState('task-lab.active', true);
    },
  };
}
