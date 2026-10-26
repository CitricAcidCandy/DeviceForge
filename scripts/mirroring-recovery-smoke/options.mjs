import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const caseDefinitions = [
  { name: 'contract-view', recoveryFixture: false, label: '恢复视图及声明合同' },
  { name: 'unsupported', recoveryFixture: false, label: '未声明恢复的插件不能清除风险' },
  { name: 'stale-generation', recoveryFixture: false, label: '旧代次不能执行恢复' },
  { name: 'active-session-recovery', recoveryFixture: false, label: '后台实际核对并跳过活跃新会话，不终止其资源' },
  { name: 'explicit-recovery', recoveryFixture: true, label: '显式恢复成功后同代再次打开' },
  { name: 'independent-reopen', recoveryFixture: true, label: '旧失败未恢复也允许跨设备独立新调用，不由打开触发全局恢复' },
  { name: 'repeated-failure', recoveryFixture: true, label: '持续失败保留风险与资源' },
  { name: 'recovering-allows-open', recoveryFixture: true, label: '旧资源后台恢复期间新会话继续，晚到确认不释放新资源' },
  { name: 'foreign-forward', recoveryFixture: true, label: '外来转发完整保留' },
  { name: 'pid-mismatch', recoveryFixture: true, label: 'PID 身份不符时不执行删除' },
  { name: 'cross-device-partial', recoveryFixture: true, label: 'A 恢复而 B 失败时 A 可再次调用，B 债务不被清零' },
  { name: 'invalid-coverage', recoveryFixture: false, hostFault: true, label: '遗漏覆盖声明或空检查不能清风险' },
  { name: 'hung-recovery-process', recoveryFixture: false, hostFault: true, label: '挂住进程不能清风险' },
  { name: 'tool-lease-debt', recoveryFixture: true, label: '旧工具租约仍存活时不能清风险' },
  { name: 'legacy-empty-global', recoveryFixture: false, hostFault: true, label: '无台账及控制状态的旧资源不能被空输入伪装全局恢复' },
  { name: 'completion-recovery', recoveryFixture: true, completionOnly: true, label: '会话结束后最多三次后台恢复，不等下一次打开' },
];

export const legacyCaseNames = Object.freeze({
  'active-session-busy': 'active-session-recovery',
  'automatic-recovery': 'independent-reopen',
  'recovering-blocks-open': 'recovering-allows-open',
});

export const help = '用法：node scripts/mirroring-recovery-smoke.mjs --frozen-input=<含apk-server.exe的目录> --plugin-input=<含manifest.json及插件的目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> [--lease-tool=<lease-holder.exe>] [--case=all|' + caseDefinitions.map(({ name }) => name).join('|') + '] [--server-version=3.3.4|3.3.1] [--browser-dist=<含恢复面板的冻结生产目录，仅explicit-recovery>]';

export function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = ['--frozen-input', '--plugin-input', '--tool', '--probe', '--case', '--server-version', '--browser-dist', '--lease-tool', '--completion-recovery'];
  const result = {};
  for (const value of args) {
    const index = value.indexOf('=');
    const key = value.slice(0, index);
    assert.ok(index > 0 && names.includes(key), '参数须为已知的 --名称=值');
    assert.ok(!Object.hasOwn(result, key), '参数不得重复');
    assert.ok(value.slice(index + 1).length > 0, '参数值不得为空');
    result[key] = value.slice(index + 1);
  }
  for (const name of names.slice(0, 4)) assert.ok(result[name], '缺少必需参数：' + name);
  const requested = result['--case'] ?? 'all';
  const selected = legacyCaseNames[requested] ?? requested;
  assert.ok(selected === 'all' || caseDefinitions.some(({ name }) => name === selected), '案例名无效');
  const version = result['--server-version'] ?? '3.3.4';
  assert.ok(['3.3.4', '3.3.1'].includes(version), 'scrcpy 版本无效');
  if (result['--browser-dist']) assert.equal(selected, 'explicit-recovery', '真实页面场景须显式选择 explicit-recovery');
  assert.ok(result['--completion-recovery'] === undefined || ['true', 'false'].includes(result['--completion-recovery']));
  return {
    hostDirectory: resolve(result['--frozen-input']), pluginDirectory: resolve(result['--plugin-input']),
    tool: resolve(result['--tool']), probe: resolve(result['--probe']), version,
    browserDist: result['--browser-dist'] ? resolve(result['--browser-dist']) : null,
    leaseTool: result['--lease-tool'] ? resolve(result['--lease-tool']) : null,
    requestedCase: requested,
    completionRecovery: result['--completion-recovery'] !== 'false',
    selected: selected === 'all' ? caseDefinitions : caseDefinitions.filter(({ name }) => name === selected),
  };
}
