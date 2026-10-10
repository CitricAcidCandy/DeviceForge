import { check, equal, log, raw, capture, pause, matchReceipt } from './browser-evidence.mjs';

// 这些转换仅用于逐字段比对真实HTTP与公开SDK，不供生产宿主使用。
function historical(row) {
  return { id: row.id, operation: row.operation, status: row.status, result: row.result ?? null,
    error: row.error ?? null, input: row.input, createdAt: row.created_at };
}
function event(row) { return { sequence: row.sequence, jobId: row.job_id, status: row.status, timestamp: row.timestamp }; }
export function assertHistory(row) {
  equal(Object.keys(row).sort(), ['createdAt', 'error', 'id', 'input', 'operation', 'result', 'status'], '历史被补写当前目录元数据');
  check(Number.isSafeInteger(row.createdAt) && row.createdAt >= 0, '历史时间不是安全整数毫秒');
}

export async function runHistoryScenarios(env) {
  const { runtime, config, signal, report, step } = env;
  await step('TH-B01-公开在线安装和真实有限任务', async () => {
    for (const kind of ['server', 'browser']) {
      const archive = await fetch('/__fixture/' + kind + '.tgz').then((reply) => {
        check(reply.ok, '本次归档不可读'); return reply.blob();
      });
      const installed = await runtime.pluginPackages.upload(kind, archive, 'application/gzip', signal);
      log(installed.logId);
      check(installed.data.id === config[kind + 'Id'], '归档安装身份不符');
      const enabled = await runtime.pluginPackages.enable(kind, installed.data.id, signal); log(enabled.logId);
    }
    const probe = env.probe(); check(probe.context.apiVersion === 2 && probe.context.taskHistory, '公开历史端口未注入');
    await runtime.webPlugins.mount(config.browserId, 'left');
    await runtime.webPlugins.mount(config.browserId, 'right');
    check(probe.panels.left.context.taskHistory && probe.panels.right.context.taskHistory, '挂载上下文缺历史端口');
    const jobs = [];
    for (let index = 0; index < 2; index += 1) {
      const input = { message: config.runId + '-' + index, value: index + 11 };
      const accepted = await probe.context.submit(config.operation, input, signal); log(accepted.logId);
      const deadline = performance.now() + 8000; let completed;
      while (true) {
        completed = await probe.context.getJob(accepted.data.id, signal); log(completed.logId);
        if (['succeeded', 'failed', 'cancelled'].includes(completed.data.status)) break;
        check(performance.now() < deadline, '有限回显任务未及时终态'); await pause();
      }
      check(completed.data.status === 'succeeded', '有限任务失败：' + completed.data.error);
      equal(completed.data.result?.result, input, '协议2公开结果包装或输入回显不符');
      equal(Object.keys(completed.data).sort(), ['error', 'id', 'operation', 'result', 'status'], '旧Job形状被改变');
      jobs.push({ id: completed.data.id, input, job: completed.data, submitLogId: accepted.logId, getLogId: completed.logId });
    }
    report.jobs = jobs;
    return { packages: [config.serverId, config.browserId], jobs, moduleIdentity: probe.moduleIdentity,
      boundedCompletionObservation: true, automaticHistoryPolling: false };
  });
  await step('TH-B02-list-get实际映射和日志关联', async () => {
    const access = env.probe().context.taskHistory; const observed = [];
    for (const query of [{}, { limit: 1 }, { limit: 200 }]) {
      const path = '/api/v2/jobs' + (query.limit === undefined ? '' : '?limit=' + query.limit);
      const reply = await access.list(query, signal); matchReceipt(reply, report, path);
      const wire = await raw(path); check(wire.status === 200, '真实历史列表失败');
      equal(reply.data, wire.data.map(historical), 'list并非真实历史camelCase映射');
      reply.data.forEach(assertHistory);
      if (query.limit === 1) check(reply.data.length === 1, '显式limit未生效');
      observed.push({ query, reply, wireLogId: wire.logId });
    }
    report.history = [];
    for (const job of report.jobs) {
      const path = '/api/v2/jobs/' + encodeURIComponent(job.id);
      const reply = await access.get(job.id, signal); matchReceipt(reply, report, path);
      const wire = await raw(path); check(wire.status === 200, '真实历史单项失败');
      equal(reply.data, historical(wire.data), 'get不是实际历史或jobId关联错误');
      equal(reply.data.input, job.input, '历史输入改变'); assertHistory(reply.data);
      report.history.push(reply.data);
    }
    return { observed, history: report.history, immutableCurrentMetadata: true };
  });
  await step('TH-B03-events序号游标和精确jobId', async () => {
    const access = env.probe().context.taskHistory; const pages = [];
    for (const job of report.jobs) {
      const path = '/api/v2/jobs/' + encodeURIComponent(job.id) + '/events';
      const reply = await access.events(job.id, {}, signal); matchReceipt(reply, report, path);
      const wire = await raw(path); check(wire.status === 200, '真实事件查询失败');
      equal(reply.data, wire.data.map(event), '事件snake/camel映射不符');
      check(reply.data.length >= 2 && reply.data.at(-1).status === 'succeeded', '有限任务事件未收敛到成功');
      let previous = 0;
      for (const row of reply.data) {
        check(row.jobId === job.id && Number.isSafeInteger(row.sequence) && row.sequence > previous,
          '事件关联或严格递增序号失效');
        check(Number.isSafeInteger(row.timestamp) && row.timestamp >= 0, '事件时间不是安全整数毫秒');
        previous = row.sequence;
      }
      const after = reply.data[0].sequence;
      const next = await access.events(job.id, { after }, signal); matchReceipt(next, report, path + '?after=' + after);
      equal(next.data, reply.data.filter((row) => row.sequence > after), '游标未排除已经消费的事件');
      const end = await access.events(job.id, { after: previous }, signal);
      matchReceipt(end, report, path + '?after=' + previous); equal(end.data, [], '终态游标之后仍返回旧事件');
      const zero = await access.events(job.id, { after: 0 }, signal);
      matchReceipt(zero, report, path + '?after=0'); equal(zero.data, reply.data, '显式0与缺省事件游标不兼容');
      pages.push({ jobId: job.id, initial: reply, wireLogId: wire.logId, after, next, end, zero });
    }
    return { pages, sequenceGapsAllowed: true, reconnectImplemented: false };
  });
  await step('TH-B04-真实错误日志及本地参数零传输', async () => {
    const access = env.probe().context.taskHistory; const id = 'absent-' + config.runId;
    const failure = await capture(() => access.get(id, signal));
    check(!failure.ok && failure.error.kind === 'http' && failure.error.status === 404
      && failure.error.code === 'not_found', 'SDK未保留真实404错误');
    matchReceipt(failure.error, report, '/api/v2/jobs/' + id, 404);
    const httpFailure = await raw('/api/v2/jobs/' + id);
    check(httpFailure.status === 404 && httpFailure.error.code === 'not_found', '真实HTTP缺失任务错误不符');
    const count = report.transport.length; const local = [];
    for (const run of [() => access.list({ limit: 0 }, signal), () => access.list({ limit: 201 }, signal),
      () => access.events(report.jobs[0].id, { after: -1 }, signal),
      () => access.events(report.jobs[0].id, { after: Number.MAX_SAFE_INTEGER + 1 }, signal),
      () => access.get('   ', signal)]) {
      const reply = await capture(run); local.push(reply);
      check(!reply.ok && reply.error.kind === 'protocol' && reply.error.code === 'invalid_history_query'
        && reply.error.logId === null, '本地参数拒绝伪造了服务日志或错误类型');
    }
    check(report.transport.length === count, '本地参数错误产生实际传输');
    return { failure, httpFailure, local, parameterTransfers: 0 };
  });
}
