import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReport, retainEvidence } from '../ordinary-deadline-http/evidence.mjs';
import { checkpointCliFailure } from '../cli-smoke-evidence.mjs';

export function createNpxReport(directory) {
  const report = createReport('npx_archive');
  Object.assign(report, {
    directory,
    phases: [],
    cli_commands: [],
    scope: '正式原CLI TGZ真实npx安装/启动，普通协议2/3新增8Job与真实越60秒、HTTP/MCP及退出',
    rust_os_pid: {
      directly_collected: false,
      pid: null,
      note: '公开CLI不暴露Rust PID，归档/shim/cache/served摘要不推断为实际PID观测',
    },
  });
  report.limitations = report.limitations.filter((item) => !item.startsWith('不含真实npx'));
  report.limitations.push('不含浏览器、真机、进程树或外部资源清理；本批只消费主代理正式归档');
  report.limitations.push(
    'Rust身份为归档→解析shim→缓存loadRuntime摘要链；未直接采集Rust OS PID或退出码',
  );
  return report;
}

// 首业务失败先写持久checkpoint，最终日志和清理信息不能覆盖原阶段/请求。
export async function checkpointFailure(report) {
  try {
    report.failure_checkpoint = await checkpointCliFailure(report);
  } catch (error) {
    report.failure_checkpoint_error = { name: error.name, code: error.code };
  }
}

export async function retainNpxEvidence(temporary, items, report) {
  await retainEvidence(temporary, items, report);
  report.retention +=
    '；本次独立npm缓存、正式CLI原TGZ副本和shim身份记录也保留，不借用后来重打包文件';
}

export async function writeNpxReport(root, report) {
  report.completed_at = new Date().toISOString();
  await mkdir(report.directory, { recursive: true });
  const path = join(report.directory, 'report.json');
  const index = join(root, 'artifacts', 'ordinary-deadline-npx-smoke.json');
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path, bytes, 'utf8');
  await writeFile(index, bytes, 'utf8');
  return { path, index };
}
