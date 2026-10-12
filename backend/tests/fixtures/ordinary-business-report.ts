// 每轮独立报告、按项刷新、只写身份摘要；失败不写断言原文或敏感载荷。
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, object, type Host, type JsonObject } from './six-business-support.ts';

export type Identity = { path: string; bytes: number; sha256: string };
export async function identities(root: string, directories: string[], files: string[]): Promise<Identity[]> {
  const paths = [...files];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  for (const directory of directories) await walk(directory);
  return Promise.all(paths.sort().map(async (path) => {
    const bytes = await readFile(path); return { path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
  }));
}
export async function reporter(directory: string, profile: string) {
  const report: JsonObject = { format_version: 1, profile, started_at: new Date().toISOString(), passed: false,
    scope: ['settings', 'ai-assistant', 'tool-supply'], evidence: '真实宿主 HTTP/MCP 与合成 CLI/配置/ZIP 源；不代表外部模型、发布工具或真机',
    checks: [], jobs: [], inputs_before: [], inputs_after: [], requests: [], tools: [], source_calls: [] };
  let active = '准备';
  const checks = report.checks as JsonObject[]; const jobs = report.jobs as JsonObject[];
  const flush = async () => {
    const temporary = join(directory, 'report.tmp');
    // Windows 文件共享冲突只重试报告发布，不重试业务或删除已发布证据。
    for (let attempt = 0; ; attempt++) {
      await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8');
      try { await rename(temporary, join(directory, 'report.json')); return; }
      catch (error) {
        const code = object(error).code;
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(String(code)) || attempt >= 6) throw error;
        const wait = 50 * 2 ** attempt;
        const retries = (report.report_write_retries ??= []) as JsonObject[];
        retries.push({ attempt: attempt + 1, code, delay_ms: wait, at: new Date().toISOString() });
        await delay(wait);
      }
    }
  };
  const failure = (error: unknown) => {
    const record = error instanceof Error ? error : new Error('非标准失败');
    const code = object(record).code;
    return { type: record.name, code: typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : null,
      message_sha256: hash(record.message), active_check: active };
  };
  const check = async (name: string, execute: () => Promise<void>) => {
    active = name; const started = Date.now();
    try { await execute(); checks.push({ name, passed: true, elapsed_ms: Date.now() - started }); }
    catch (error) { checks.push({ name, passed: false, elapsed_ms: Date.now() - started, failure: failure(error) }); await flush(); throw error; }
    await flush();
  };
  const recordJob = async (host: Host, job: JsonObject, expected: string, operation: string) => {
    // 用公开任务摘要追踪 HTTP/MCP 同一身份，不持久化输入或结果正文。
    jobs.push({ id: job.id, operation, expected_status: expected, status: job.status,
      input_sha256: hash(JSON.stringify(job.input ?? null)), error_sha256: typeof job.error === 'string' ? hash(job.error) : null });
    await flush(); await host.shared(String(job.id));
  };
  await flush(); return { report, check, flush, failure, recordJob };
}
export type Reporter = Awaited<ReturnType<typeof reporter>>;
