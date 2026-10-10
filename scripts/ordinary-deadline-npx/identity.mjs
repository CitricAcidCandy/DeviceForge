import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { preserveCliArchive, captureNpxRuntime, verifyServedHost } from '../cli-smoke-evidence.mjs';
import { verifyArchiveCache } from '../cli-smoke-archive.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { loadRuntime } from '../../cli/src/runtime.mjs';

// 只消费主代理给出的正式原TGZ；不执行npm pack或重新生成替代归档。
export async function preserveArchive(archive, report) {
  assert.ok(archive.endsWith('.tgz'), '必须明确指定正式TGZ原件');
  const metadata = await lstat(archive);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 64 * 1024 * 1024);
  await preserveCliArchive(archive, report);
  const original = await fileIdentity(archive);
  assert.equal(original.sha256, report.archive.sha256);
  assert.equal(original.bytes, report.archive.bytes);
  report.executed_archive_path = archive;
}

export async function runtimeIdentity(host, report) {
  const entry = await captureNpxRuntime(host.cache, report, '普通操作默认免令牌');
  await verifyServedHost(host.client.base, entry);
  const runtime = await loadRuntime(entry.package_root);
  const binary = entry.resources.filter((resource) => resource.path === runtime.binary);
  assert.equal(binary.length, 1);
  const npx = await fileIdentity(host.npx);
  report.runtime_identity = { package_root: entry.package_root,
    binary: binary[0], npx_entry: npx, shim: entry.archive_cache.bin,
    archive_sha256: entry.archive_sha256, matched_archive_members: entry.archive_cache.matched_files,
    rust_pid_directly_collected: false,
    scope: '实际npx缓存/解析shim/loadRuntime摘要的静态身份链；served host只证明响应资源字节，不证明Rust PID' };
  return entry;
}

export async function verifyRuntimeUnchanged(host, entry, report) {
  const original = await fileIdentity(report.archive.source_path);
  const retained = await fileIdentity(report.archive.path);
  assert.equal(original.sha256, report.archive.sha256);
  assert.equal(retained.sha256, report.archive.sha256);
  entry.archive_identity_after = { original, retained };
  entry.archive_cache_after = await verifyArchiveCache(report.archive.path, entry.package_root,
    entry.resources, report.archive.sha256);
  assert.equal(entry.archive_cache_after.bin.sha256, entry.archive_cache.bin.sha256);
  assert.equal(entry.archive_cache_after.bin.parsed_target, entry.archive_cache.bin.parsed_target);
  report.runtime_identity.binary_after = await fileIdentity(report.runtime_identity.binary.path);
  assert.equal(report.runtime_identity.binary_after.sha256, report.runtime_identity.binary.sha256);
  const npx = await fileIdentity(host.npx);
  assert.equal(npx.sha256, report.runtime_identity.npx_entry.sha256);
}

// 实际宿主PID不可见于公开CLI；单次启动/正常结束日志只证明本轮日志观察，另保留该边界。
export async function verifyHostLifecycleLogs(host, report) {
  const folder = join(host.directory, 'logs');
  const names = (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort();
  let starts = 0, ends = 0, successfulEnds = 0;
  for (const name of names) {
    const bytes = await readFile(join(folder, name));
    assert.ok(bytes.length <= 16 * 1024 * 1024);
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.fields?.message === '宿主日志服务已启动') starts++;
      if (record.fields?.message === '宿主运行已结束') {
        ends++;
        if (record.fields.success === true) successfulEnds++;
      }
    }
  }
  assert.equal(starts, 1, '本次日志只能观察到一次Rust宿主启动');
  assert.equal(ends, 1);
  assert.equal(successfulEnds, 1);
  report.rust_lifecycle = { observed_start_records: starts, observed_end_records: ends,
    successful_end_records: successfulEnds, directly_collected_pid: false,
    directly_collected_os_exit_code: false, npx_wrapper_exit_code: report.npx_wrapper.exit.code,
    scope: '正常宿主结束日志与CLI包装exit0；不是直接OS Rust PID/退出码采集' };
}
