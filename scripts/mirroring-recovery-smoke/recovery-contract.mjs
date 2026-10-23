import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 首轮精确模板已从插件代理交接并独立冻结；工具债务格式仍单列待交接。
export const recoveryFixtureContract = Object.freeze({
  ready: true,
  revision: 'frozen-01-owner-pid-start-boot-v1',
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
  assert.equal(context.name, 'recovering-blocks-open');
  await writeFile(join(plan, 'hold-recovery'), '1', { flag: 'wx' });
  return { release: () => writeFile(join(plan, 'release-recovery'), '1', { flag: 'wx' }) };
}
