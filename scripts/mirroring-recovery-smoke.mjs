import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { help, parseOptions } from './mirroring-recovery-smoke/options.mjs';
import { driverIdentities, freezeInputs, verifyFrozenInputs } from './mirroring-recovery-smoke/freeze.mjs';
import { failureSummary } from './mirroring-recovery-smoke/evidence.mjs';
import { pendingContract, recoveryFixtureContract } from './mirroring-recovery-smoke/recovery-contract.mjs';
import { runCase } from './mirroring-recovery-smoke/run-case.mjs';
import { runFaultCase } from './mirroring-recovery-smoke/fault-run-case.mjs';

const options = parseOptions(process.argv.slice(2));
if (options.help) console.log(help);
else await run(options);

async function run(selected) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const runId = randomUUID(), directory = join(root, 'artifacts', 'mirroring-recovery-smoke-' + runId);
  const report = {
    timestamp: new Date().toISOString(), run_id: runId, passed: false, status: 'running',
    selected_cases: selected.selected.map(({ name }) => name), server_version: selected.version,
    recovery_fixture_contract: recoveryFixtureContract, cases: [],
    scope: '独占真实宿主、真实插件进程、原生模拟设备与 HTTP 恢复/保护行为',
    limitations: [
      '不操作用户预览服务、真实设备或系统 ADB/HDC；不执行 Cargo 构建',
      '模拟资源与合成媒体不证明真机、WebRTC 解码播放、输入、音频、长时或正式分发',
      '恢复精确命令与台账未交接的案例明确待接入，不计为通过',
      'OS 句柄证据限本轮直接工具、插件及探针，不推断任意未知派生树',
    ],
  };
  await mkdir(directory);
  let stage = '冻结输入';
  try {
    assert.equal(process.platform, 'win32', '本轮原生 OS 探针验收只支持 Windows');
    report.driver_inputs = await driverIdentities(fileURLToPath(import.meta.url));
    const { snapshot, manifest } = await freezeInputs(selected, directory, report);
    for (const definition of selected.selected) {
      stage = '案例：' + definition.name;
      const current = definition.recoveryFixture && (!recoveryFixtureContract.ready || recoveryFixtureContract.pending_cases.includes(definition.name)) ||
        definition.name === 'tool-lease-debt' && !selected.leaseTool
        ? pendingContract(definition.name)
        : definition.hostFault ? await runFaultCase({ snapshot, directory, definition, manifest, runId })
        : await runCase({ snapshot, directory, definition, manifest, version: selected.version, runId,
          browserDist: selected.browserDist });
      if (current.status === 'pending_contract') {
        await mkdir(join(directory, definition.name));
        await writeFile(join(directory, definition.name, 'report.json'), JSON.stringify(current, null, 2) + '\n', 'utf8');
      }
      report.cases.push(current);
      console.log(JSON.stringify({ run_id: runId, scenario: current.scenario, status: current.status }));
      // 回收失败时停止后续案例，避免遗留进程继续累积。
      if (current.cleanup_errors.length) break;
    }
    report.passed = report.cases.length === selected.selected.length && report.cases.every((item) => item.passed);
    report.status = report.passed ? 'passed'
      : report.cases.some((item) => item.status === 'failed') ? 'failed' : 'pending_contract';
  } catch (error) {
    report.status = 'failed';
    report.failure = failureSummary(error, stage);
  } finally {
    try { await verifyFrozenInputs(report); report.inputs_stable = true; }
    catch (error) {
      report.inputs_stable = false; report.passed = false; report.status = 'failed';
      report.identity_failure = failureSummary(error, '受检输入摘要收尾');
    }
    report.process_recovery = report.cases.map(({ scenario, process_recovery }) => ({ scenario, ...process_recovery }));
    report.not_run_cases = selected.selected.map(({ name }) => name)
      .filter((name) => !report.cases.some((item) => item.scenario === name));
    report.completed_at = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ directory, passed: report.passed, status: report.status,
      counts: Object.fromEntries(['passed', 'failed', 'pending_contract'].map((status) =>
        [status, report.cases.filter((item) => item.status === status).length])) }));
    if (!report.passed) process.exitCode = 1;
  }
}
