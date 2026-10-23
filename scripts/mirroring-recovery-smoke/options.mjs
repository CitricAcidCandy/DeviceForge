import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const caseDefinitions = [
  { name: 'contract-view', recoveryFixture: false, label: '恢复视图及声明合同' },
  { name: 'unsupported', recoveryFixture: false, label: '未声明恢复的插件不能清除风险' },
  { name: 'stale-generation', recoveryFixture: false, label: '旧代次不能执行恢复' },
  { name: 'active-session-busy', recoveryFixture: false, label: '活跃会话返回忙碌且不被终止' },
  { name: 'explicit-recovery', recoveryFixture: true, label: '显式恢复成功后同代再次打开' },
  { name: 'automatic-recovery', recoveryFixture: true, label: '会话准入自动恢复且同代再次打开' },
  { name: 'repeated-failure', recoveryFixture: true, label: '持续失败保留风险与资源' },
  { name: 'recovering-blocks-open', recoveryFixture: true, label: '恢复进行中禁止新会话' },
  { name: 'foreign-forward', recoveryFixture: true, label: '外来转发完整保留' },
  { name: 'pid-mismatch', recoveryFixture: true, label: 'PID 身份不符时不执行删除' },
  { name: 'cross-device-partial', recoveryFixture: true, label: 'A 恢复而 B 失败时保留全局风险' },
  { name: 'invalid-coverage', recoveryFixture: false, hostFault: true, label: '遗漏覆盖声明或空检查不能清风险' },
  { name: 'hung-recovery-process', recoveryFixture: false, hostFault: true, label: '挂住进程不能清风险' },
  { name: 'tool-lease-debt', recoveryFixture: true, label: '旧工具租约仍存活时不能清风险' },
  { name: 'legacy-empty-global', recoveryFixture: false, hostFault: true, label: '无台账及控制状态的旧资源不能被空输入伪装全局恢复' },
];

export const help = '用法：node scripts/mirroring-recovery-smoke.mjs --frozen-input=<含apk-server.exe的目录> --plugin-input=<含manifest.json及插件的目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> [--lease-tool=<lease-holder.exe>] [--case=all|' + caseDefinitions.map(({ name }) => name).join('|') + '] [--server-version=3.3.4|3.3.1] [--browser-dist=<含恢复面板的冻结生产目录，仅explicit-recovery>]';

export function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = ['--frozen-input', '--plugin-input', '--tool', '--probe', '--case', '--server-version', '--browser-dist', '--lease-tool'];
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
  const selected = result['--case'] ?? 'all';
  assert.ok(selected === 'all' || caseDefinitions.some(({ name }) => name === selected), '案例名无效');
  const version = result['--server-version'] ?? '3.3.4';
  assert.ok(['3.3.4', '3.3.1'].includes(version), 'scrcpy 版本无效');
  if (result['--browser-dist']) assert.equal(selected, 'explicit-recovery', '真实页面场景须显式选择 explicit-recovery');
  return {
    hostDirectory: resolve(result['--frozen-input']), pluginDirectory: resolve(result['--plugin-input']),
    tool: resolve(result['--tool']), probe: resolve(result['--probe']), version,
    browserDist: result['--browser-dist'] ? resolve(result['--browser-dist']) : null,
    leaseTool: result['--lease-tool'] ? resolve(result['--lease-tool']) : null,
    selected: selected === 'all' ? caseDefinitions : caseDefinitions.filter(({ name }) => name === selected),
  };
}
