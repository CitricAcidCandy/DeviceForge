import { createFrontendRuntime } from '/assets/plugin-host.js';

const browserId = 'ordinary_deadline_browser_probe';
const probeKey = Symbol.for('deviceforge.ordinary-deadline-browser.probe');
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (left, right, message) => check(JSON.stringify(left) === JSON.stringify(right), message);
const brief = (error) => ({ message: String(error?.message ?? error).slice(0, 600),
  kind: error?.kind ?? null, code: error?.code ?? null, logId: error?.logId ?? null, status: error?.status ?? null });
const capture = async (run) => {
  // 撤销后的公开入口可以同步拒绝；调用必须发生在捕获范围内。
  try { return { ok: true, result: await run() }; } catch (error) { return { ok: false, error: brief(error) }; }
};
const keys = (value) => Object.keys(value).sort();
const hasLog = (value) => check(typeof value === 'string' && value.trim().length > 0, '真实响应缺少日志 ID');

function checkBudgets(entries, fixtures, wire) {
  const observed = [];
  for (const fixture of fixtures) for (const name of ['long', 'short', 'default']) {
    const entry = entries.find((candidate) => candidate.id === fixture.operations[name]);
    check(entry && record(entry.execution), '当前目录缺少普通 execution：' + fixture.operations[name]);
    const execution = entry.execution;
    equal(keys(execution), wire ? ['api_version', 'source', 'total_timeout_ms'] : ['apiVersion', 'source', 'totalTimeoutMs'],
      '执行元数据不是严格 snake_case/camelCase 对象');
    check((wire ? execution.api_version : execution.apiVersion) === 1, '执行元数据版本错误');
    check((wire ? execution.total_timeout_ms : execution.totalTimeoutMs) === ({ long: 120000, short: 10000, default: 60000 })[name],
      '目录总预算与冻结声明不符');
    check(execution.source === (name === 'default' ? 'default' : 'declared'), 'default/declared 来源错误');
    observed.push({ id: entry.id, execution });
  }
  return observed;
}
function businessResult(job) {
  check(record(job.result) && record(job.result.result) && Array.isArray(job.result.artifacts),
    '普通协议任务结果未按公开 result/artifacts 包装消费');
  check(job.result.artifacts.length === 0, '有限 default 夹具不应发布产物');
  return job.result.result;
}
function checkHistory(job, operation) {
  equal(keys(job), ['error', 'id', 'operation', 'result', 'status'], 'SDK Job 被补入当前目录元数据');
  check(job.status === 'succeeded' && job.operation === operation, '历史任务身份或终态变化');
  check(!Object.hasOwn(job, 'execution') && !Object.hasOwn(job, 'totalTimeoutMs'), '历史任务出现当前预算');
}

export async function verifyOrdinaryDeadline() {
  const report = { passed: false, steps: [], history: [], imports: [],
    boundary: { longExecutionVerified: false, over61SecondsVerified: false, productUi: false, realDevice: false } };
  const signal = AbortSignal.timeout(75000);
  const control = async (path, body) => {
    const response = await fetch(path, { signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    check(response.ok, '本次验收控制失败：' + path + '/' + response.status);
    return response.json();
  };
  const config = await control('/__config');
  const fixtures = config.fixtures;
  check(Array.isArray(fixtures) && fixtures.length === 2, '未接入两种真实协议服务器包');
  const runtime = createFrontendRuntime({ baseUrl: location.origin, transport: fetch.bind(globalThis), panelTarget: () => null,
    esmImporter: async (url, current) => {
      current.throwIfAborted(); const loaded = await import(url); current.throwIfAborted();
      report.imports.push(url); return loaded;
    },
  });
  const step = async (name, run) => {
    const evidence = { name, startedAt: new Date().toISOString(), passed: false }; report.steps.push(evidence);
    try { evidence.result = await run(); evidence.passed = true; }
    catch (error) { evidence.error = brief(error); throw error; }
    finally { evidence.finishedAt = new Date().toISOString(); }
  };
  const wire = async (path) => {
    const response = await fetch(path, { signal });
    const envelope = await response.json(); check(response.ok, '真实 HTTP 查询失败：' + path + '/' + response.status);
    hasLog(envelope.log_id); check(envelope.log_id === response.headers.get('x-deviceforge-log-id'), 'v2 包装和响应头日志不一致');
    return envelope;
  };
  const inspect = () => runtime.extensions.executeCommand(browserId + '.inspect', {}, signal);
  const readHistory = async (item) => {
    const reply = await runtime.host.getJob(item.job.id, signal); hasLog(reply.logId);
    checkHistory(reply.data, item.operation); equal(reply.data, item.job, '目录换代改写历史 SDK Job');
    const raw = await wire('/api/v2/jobs/' + encodeURIComponent(item.job.id));
    check(!Object.hasOwn(raw.data, 'execution'), 'HTTP 历史 Job 被补当前预算');
    check(raw.data.operation === item.operation && raw.data.input.case_id === item.caseId, 'HTTP 历史 input/operation 变化');
    equal(raw.data.result, item.job.result, '历史结果包装被重新解释');
    return { id: item.job.id, sdkLogId: reply.logId, httpLogId: raw.log_id };
  };
  try {
    await step('LONG-B01-真实在线安装', async () => {
      const installed = [];
      for (const fixture of fixtures) {
        const archive = await fetch('/__fixture/server-' + fixture.protocolVersion + '.tgz', { signal });
        check(archive.ok, '服务器 TGZ 不可读');
        const uploaded = await runtime.pluginPackages.upload('server', await archive.blob(), 'application/gzip', signal);
        check(uploaded.data.id === fixture.pluginId, '服务器安装身份不一致'); hasLog(uploaded.logId);
        await runtime.pluginPackages.enable('server', fixture.pluginId, signal);
        installed.push({ id: uploaded.data.id, logId: uploaded.logId });
      }
      const archive = await fetch('/__fixture/browser.tgz', { signal }); check(archive.ok, '浏览器 TGZ 不可读');
      const uploaded = await runtime.pluginPackages.upload('browser', await archive.blob(), 'application/gzip', signal);
      check(uploaded.data.id === browserId, '浏览器包身份错误'); hasLog(uploaded.logId);
      await runtime.pluginPackages.enable('browser', browserId, signal);
      check(runtime.host.apiVersion === 2 && globalThis[probeKey], '真实插件未取得 SDK2 上下文');
      return { server: installed, browser: { id: browserId, logId: uploaded.logId } };
    });
    await step('LONG-B02-真实wire到公开SDK及订阅', async () => {
      const raw = await wire('/api/v2/operations'); const http = checkBudgets(raw.data, fixtures, true);
      const reply = await inspect(); hasLog(reply.logId);
      check(reply.data.apiVersion === 2, '浏览器公开 SDK 版本变化');
      const sdk = checkBudgets(reply.data.operations, fixtures, false);
      await runtime.operations.refresh(signal);
      const probe = globalThis[probeKey]; check(probe.notifications.length > 0, '真实插件没有收到目录订阅');
      const latest = probe.notifications.at(-1); checkBudgets(latest, fixtures, false);
      return { http, sdk, httpLogId: raw.log_id, sdkLogId: reply.logId, notifications: probe.notifications.length };
    });
    await step('LONG-B03-两协议有限default任务', async () => {
      const calls = [];
      for (const fixture of fixtures) {
        const began = performance.now();
        const reply = await runtime.extensions.executeCommand(browserId + '.submit-default',
          { pluginId: fixture.pluginId, caseId: fixture.caseId }, signal);
        hasLog(reply.logId); checkHistory(reply.data.job, fixture.operations.default);
        for (const log of reply.data.logs) hasLog(log.logId);
        const result = businessResult(reply.data.job);
        check(result.run_id === fixture.runId && result.case_id === fixture.caseId
          && result.plugin_id === fixture.pluginId && result.protocol_version === fixture.protocolVersion, '有限任务身份不属于本次夹具');
        const proof = await control('/__control/verify-default', { pluginId: fixture.pluginId,
          caseId: fixture.caseId, result });
        check(proof.passed === true && proof.pidAbsent === true, 'default 进程事件和真实 PID 退出未核对');
        const item = { job: reply.data.job, operation: fixture.operations.default, caseId: fixture.caseId };
        report.history.push(item);
        calls.push({ protocolVersion: fixture.protocolVersion, jobId: reply.data.job.id,
          elapsedBrowserMs: performance.now() - began, logId: reply.logId, logs: reply.data.logs, result, proof });
      }
      return { calls, longSubmitted: false, shortHoldSubmitted: false, over61SecondsVerified: false };
    });
    await step('LONG-B04-服务器卸载目录撤销及历史不补预算', async () => {
      for (const fixture of fixtures) await runtime.pluginPackages.disable('server', fixture.pluginId, signal);
      const ids = new Set(fixtures.flatMap((fixture) => Object.values(fixture.operations)));
      const current = await runtime.host.listOperations(signal); hasLog(current.logId);
      check(!current.data.some((entry) => ids.has(entry.id)), '服务器停用后普通入口残留');
      const probe = globalThis[probeKey];
      check(!probe.notifications.at(-1)?.some((entry) => ids.has(entry.id)), '公开订阅保留已撤销目录');
      const unloadedHistory = [];
      for (const item of report.history) unloadedHistory.push(await readHistory(item));
      for (const fixture of fixtures) await runtime.pluginPackages.enable('server', fixture.pluginId, signal);
      const reloaded = await inspect(); hasLog(reloaded.logId); checkBudgets(reloaded.data.operations, fixtures, false);
      const reloadedHistory = [];
      for (const item of report.history) reloadedHistory.push(await readHistory(item));
      return { revoked: true, unloadedHistory, reloadedHistory, reloadLogId: reloaded.logId };
    });
    await step('LONG-B05-浏览器热卸载及原上下文撤销', async () => {
      const old = globalThis[probeKey]; check(old, '旧插件身份未采集');
      await runtime.pluginPackages.disable('browser', browserId, signal);
      check(old.closed === true, '卸载未释放插件登记生命周期');
      const notices = old.notifications.length;
      const oldCall = await capture(() => old.context.listOperations(signal));
      check(!oldCall.ok && oldCall.error.kind === 'cancelled' && oldCall.error.logId === null, '旧上下文复活或伪造服务日志');
      const unavailable = await capture(inspect);
      check(!unavailable.ok && unavailable.error.code === 'command_unavailable', '已卸载命令仍可调用');
      await runtime.operations.refresh(signal);
      check(old.notifications.length === notices, '卸载订阅仍接收目录');
      await runtime.pluginPackages.enable('browser', browserId, signal);
      const next = globalThis[probeKey];
      check(next && next !== old && next.dependencyRun !== old.dependencyRun, '新代复用旧相对模块状态');
      const reloaded = await inspect(); checkBudgets(reloaded.data.operations, fixtures, false); hasLog(reloaded.logId);
      const oldAfterReload = await capture(() => old.context.getJob(report.history[0].job.id, signal));
      check(!oldAfterReload.ok && oldAfterReload.error.kind === 'cancelled', '浏览器新代使旧引用复活');
      return { oldDependencyRun: old.dependencyRun, newDependencyRun: next.dependencyRun, oldCall,
        oldAfterReload, unavailable, releasedSubscriptions: true, esmMemoryUnloaded: false };
    });
    await step('LONG-B06-在线删除及历史仍可查询', async () => {
      await runtime.pluginPackages.remove('browser', browserId, signal);
      for (const fixture of fixtures) await runtime.pluginPackages.remove('server', fixture.pluginId, signal);
      const server = await runtime.pluginPackages.refresh('server', signal);
      const browser = await runtime.pluginPackages.refresh('browser', signal);
      check(server.data.length === 0 && browser.data.length === 0, '本次在线部署未删除');
      const history = [];
      for (const item of report.history) history.push(await readHistory(item));
      return { currentInstanceStopped: true, serverPackages: 0, browserPackages: 0, history };
    });
    report.passed = true;
  } catch (error) { report.error = brief(error); }
  finally {
    try { await runtime.dispose(); report.runtimeDisposed = true; }
    catch (error) { report.disposeError = brief(error); report.passed = false; }
    delete globalThis[probeKey];
  }
  return report;
}
