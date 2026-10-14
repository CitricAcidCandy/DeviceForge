import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export { inputManifest, retain, verifyLogs } from '../harmony-screenshot-smoke/evidence.mjs';

export function reportFor(profile) {
  return {
    timestamp: new Date().toISOString(),
    run_id: randomUUID(),
    profile,
    mode: 'service',
    passed: false,
    checks: [],
    requests: [],
    jobs: [],
    metadata_jobs: [],
    rounds: [],
    scope:
      '十二贡献十一能力冻结版、真实HTTP/MCP三入口四动作、资格、严格输入、真实父子OS退出、写锁、取消及代际历史',
    limitations: [
      '假HDC不证明真实设备输入效果、商业HarmonyOS、剪贴板内容或注入服务实际送达',
      '服务便携目录不证明正式TGZ、CLI install、npx或registry发布',
      '有限目录和Job采样不证明内部注册原子性、全部竞争情形或性能',
      'OS探针仅观察取得句柄的客户端与直接父进程，不泛称派生进程树清理',
      '已知exit7完整回执缺陷保持独立未通过，不借当前粘性拒绝计业务成功',
    ],
  };
}

export function failure(report, error, stage = report.stage) {
  report.passed = false;
  const recorded = {
    stage,
    case_id: report.active_case_id,
    name: error.name,
    code: error.code,
    operator: error.operator,
    message: error instanceof Error ? error.message.slice(0, 2048) : undefined,
  };
  if (report.failure) (report.secondary_errors ??= []).push(recorded);
  else {
    report.failure = recorded;
    report.failed_request ??= report.last_request;
    report.error_locations = String(error.stack ?? '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 8);
  }
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const directory = join(
    root,
    'artifacts',
    'harmony-input-service-' + report.profile + '-' + report.run_id,
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'report.json');
  report.report_path = path;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return path;
}
