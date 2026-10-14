import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export function failure(report, error) {
  report.passed = false;
  const recorded = {
    stage: report.stage,
    case_id: report.active_case_id,
    name: error.name,
    code: error.code,
  };
  if (report.failure) (report.secondary_errors ??= []).push(recorded);
  else {
    report.failure = recorded;
    report.failed_request ??= report.last_request;
  }
}

export async function lifecycleLogs(host, report, token) {
  let starts = 0,
    ends = 0,
    successfulEnds = 0;
  for (const name of (await readdir(join(host.directory, 'logs'))).filter((name) =>
    name.endsWith('.jsonl'),
  )) {
    const bytes = await readFile(join(host.directory, 'logs', name));
    assert.ok(bytes.length <= 16 * 1024 * 1024);
    if (token) assert.ok(!bytes.toString('utf8').includes(token));
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.fields?.message === '宿主日志服务已启动') starts++;
      if (record.fields?.message === '宿主运行已结束') {
        ends++;
        if (record.fields.success === true) successfulEnds++;
      }
    }
  }
  assert.equal(starts, 2);
  assert.equal(ends, 2);
  assert.equal(successfulEnds, 2);
  report.rust_lifecycle = {
    observed_start_records: starts,
    observed_end_records: ends,
    successful_end_records: successfulEnds,
    directly_collected_pid: false,
    directly_collected_os_exit_code: false,
    boundary:
      '同一数据目录两次宿主日志与npx包装exit0；公开CLI不暴露Rust PID，未直接采集Rust OS退出码',
  };
}

export async function retainEvidence(temporary, report, token) {
  const selected = new Set();
  let count = 0;
  const visit = async (directory, depth = 0) => {
    assert.ok(depth <= 5);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++count <= 256);
      assert.ok(!entry.isSymbolicLink());
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile()) selected.add(path);
    }
  };
  for (const name of ['tool', 'harmony-private-scratch']) {
    try {
      await visit(join(temporary, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const data = join(temporary, 'data');
  try {
    for (const name of (await readdir(data)).filter((name) => name.endsWith('.db')))
      selected.add(join(data, name));
    await visit(join(data, 'logs'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (report.plugin?.configuration) {
    selected.add(report.plugin.configuration.materialized.path);
    selected.add(report.plugin.configuration.materialized_bindings.path);
  }
  const retainedRoot = join(report.directory, 'business-evidence');
  await mkdir(retainedRoot);
  report.retained_files = [];
  for (const path of [...selected].sort()) {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024);
    const bytes = await readFile(path);
    if (token && path.endsWith('.jsonl')) assert.ok(!bytes.toString('utf8').includes(token));
    const retainedPath = join(
      retainedRoot,
      String(report.retained_files.length).padStart(3, '0') + '-' + path.split(/[\\/]/).at(-1),
    );
    await writeFile(retainedPath, bytes, { flag: 'wx' });
    const retained = await fileIdentity(retainedPath);
    assert.equal(retained.sha256, createHash('sha256').update(bytes).digest('hex'));
    report.retained_files.push({ source_path: path, ...retained });
  }
  report.temporary_retained = temporary;
}
