import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { assertRecoveryView } from './http.mjs';
import { toolCount } from './fixtures.mjs';

// 最后一次后台续办延迟 1000ms；观察空闲窗口，不能在首次 blocked 瞬间改故障。
export async function settleFailedCompletion(context) {
  if (!context.completionRecovery || context.name === 'unsupported') return;
  let previousCount = -1, quietSince = performance.now();
  return poll(async () => {
    const value = assertRecoveryView(await context.host.client.recovery(), {
      generation: context.generation, supported: true,
    });
    const count = await toolCount(context.fixture);
    if (value.recovering || count !== previousCount) quietSince = performance.now();
    previousCount = count;
    return { value, quiet_ms: performance.now() - quietSince };
  }, ({ value, quiet_ms }) => !value.recovering &&
    ['blocked', 'busy'].includes(value.last_report?.status) && value.cleanup_failed && quiet_ms >= 1600,
  '原故障下最多三次后台续办结束，风险保留且经过最后退避空闲窗', 110000);
}

// 在宿主正常退出后核对原日志计数；空闲窗只协调时序，不冒充最大重试次数的证据。
export function assertRecoveryBudget(report) {
  const runs = report.logging.recovery_runs;
  const explicit = report.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/recovery')).length;
  const perSession = report.resource_isolation_policy.automatic_recovery_max_attempts;
  const maximum = report.scenario === 'completion-recovery' ? perSession : report.sessions.length * perSession + explicit;
  assert.equal(runs.started, runs.finished, '真实核对开始与结束日志必须配对');
  assert.ok(runs.started <= maximum, '后台核对不能超过每次结束最多三次与显式请求的总上限');
  if (report.scenario === 'completion-recovery') {
    assert.equal(explicit, 0);
    assert.ok(runs.started >= 1, '完成后的自动核对必须真正启动');
  }
  report.background_recovery_budget = { ...runs, explicit_requests: explicit,
    automatic_max_per_session: perSession, allowed_total: maximum };
}
