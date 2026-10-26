import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';

// 第二轮精确模板独立冻结，包含可读目录审计与排除审计进程自身的核对。
export const recoveryFixtureContract = Object.freeze({
  ready: true,
  revision: 'frozen-02-owner-pid-start-boot-audit-v2',
  pending_cases: [],
  required: [
    '恢复调用的配置读取、声明操作及精确 ADB shell 模板',
    '台账根目录、文件名、版本、字段及原子写入约定',
    '会话落盘与完成释放的台账生命周期',
    '远端目录缺失、PID 不存在与 PID 身份不符的固定回执',
    '恢复状态核对和持久控制权解除的锁顺序',
    '工具租约债务文件字段、存活核对与确认归还条件',
  ],
});

// 行为裁定与精确 shell 模板版本分别留证，不能把旧冻结的通过套给本策略。
export const isolationPolicy = Object.freeze({
  revision: '20261023-scoped-debt-background-reaping-v1',
  expected_host_freeze: 'frozen-06',
  historical_cleanup_failed_blocks_new_calls: false,
  recovery_freezes_ordinary_calls: false,
  automatic_recovery_delays_ms: [0, 250, 1000],
  automatic_recovery_max_attempts: 3,
});

export function pendingContract(name) {
  return {
    scenario: name, status: 'pending_contract', passed: false,
    reason: '本例必需原生工具或精确合同未就绪，不能放行未知 shell 或伪造台账',
    required_contracts: recoveryFixtureContract.required,
    cleanup_errors: [], process_recovery: { spawned: [], user_processes_touched: false },
  };
}

export async function holdRecovery(context) {
  const plan = context.fixture.plan(context.fixture.device);
  assert.equal(context.name, 'recovering-allows-open');
  await writeFile(join(plan, 'hold-recovery'), '1', { flag: 'wx' });
  return {
    wait: () => poll(async () => {
      context.observer.assertHealthy();
      for (const entry of context.report.tools.filter((item) => item.category === 'list-forward' &&
        item.argv[1] === context.fixture.device)) {
        try { if (await readFile(join(entry.directory, 'recovery-waiting'), 'utf8') === '1') return true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return false;
    }, Boolean, '本次恢复已实际执行到原生旧资源门闩', 8000),
    release: () => writeFile(join(plan, 'release-recovery'), '1', { flag: 'wx' }),
  };
}
