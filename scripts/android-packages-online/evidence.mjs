import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
export { retain, verifyLogs } from '../android-packages-smoke/evidence.mjs';

export function reportFor(profile) {
  return {
    timestamp: new Date().toISOString(),
    profile,
    passed: false,
    checks: [],
    requests: [],
    jobs: [],
    scope:
      '原TGZ公开在线安装/加载，4Job真实Rust HTTP/MCP、旧alias同Job投影、实际产物下载、卸载重载及部署删除',
    limitations: [
      '仅执行extract_apk与scan_sdks，其它五操作只核目录注册',
      '本次无工具配置或真实Android工具，不计真机、CLI install或npx',
      '直接采宿主PID与正常退出；未直接采四个插件进程OS PID或退出码',
      '插件request_id来自同Job宿主日志，未截获插件stdin原帧',
      '装卸端点采样不证明内部原子性或清理所有外部资源',
      '新代仅验证注册与历史保留，不额外执行第五个Job',
      '有界看门狗与10000限流配置不提供性能结论',
      '复用TAR读取只作正式原件身份关联，不宣称完整恶意TAR覆盖',
    ],
  };
}

export function failure(report, error, stage = report.stage) {
  report.passed = false;
  if (report.failure_stage !== undefined) {
    report.secondary_errors ??= [];
    report.secondary_errors.push({ stage, name: error.name, code: error.code });
    return;
  }
  report.failure_stage = stage;
  report.failed_request ??= report.last_request ? { ...report.last_request } : undefined;
  report.error = {
    name: error.name,
    code: error.code,
    operator: error.operator,
    summary: '按首失败阶段、关联请求及本次保留原件定位，不输出任意响应正文或凭据',
  };
  if (report.temporary_root && typeof error.path === 'string') {
    const path = relative(report.temporary_root, error.path);
    if (!isAbsolute(path) && !path.startsWith('..')) report.error.filesystem_path = path;
  }
  report.error_locations = String(error.stack ?? '')
    .split('\n')
    .filter(
      (line) =>
        /^\s+at /.test(line) &&
        /android-packages-online|android-packages-smoke|unified-discovery-smoke[\\/]evidence|device-provider[\\/]client/.test(
          line,
        ),
    )
    .slice(0, 6);
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const directory = join(root, 'artifacts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `android-packages-online-smoke-${report.profile}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
