import * as useCases from './use-cases.mjs';

export function createContributions(id, session) {
  const command = (name, title, run) => ({ id: id + '.' + name, title,
    execute: (input, context, signal) => run(session, context, input, signal) });
  return {
    commands: [
      command('catalog', '读取公开操作与设备观测', useCases.catalog),
      command('refresh-devices', '查询当前提供者与设备目录', useCases.refreshDevices),
      command('discover', '发现指定提供者当代设备', useCases.discover),
      command('select', '选择完整设备引用', useCases.select),
      command('invoke-read', '调用精确版本的只读设备能力', useCases.invokeRead),
      command('submit', '通过公开任务入口提交一次操作', useCases.submit),
      command('get-job', '独立查询历史任务', useCases.getJob),
      command('cancel-job', '显式请求服务器取消任务', useCases.cancelJob),
    ],
    services: [
      { id: id + '.catalog-service', version: '1.0.0',
        invoke: (input, context, signal) => useCases.catalog(session, context, input, signal) },
      { id: id + '.history-service', version: '1.0.0',
        invoke: (input, context, signal) => useCases.getJob(session, context, input, signal) },
    ],
    beforeTaskSubmit: [{ id: id + '.require-current-operation', priority: 0,
      transform: (submission, context, signal) => useCases.requireCurrentOperation(session, context, submission, signal) }],
  };
}
