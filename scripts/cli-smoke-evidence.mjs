import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { loadRuntime } from '../cli/src/runtime.mjs';
import { verifyArchiveCache } from './cli-smoke-archive.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function identity(path) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: digest(bytes) };
}

// 本次真正执行的归档单独保留，不能用后来重新打包的文件代替。
export async function createCliEvidence(root, temporary) {
  const directory = await mkdtemp(join(root, 'artifacts', 'npx-raw-'));
  return {
    directory,
    temporary,
    command: 'node scripts/cli-smoke.mjs',
    started_at: new Date().toISOString(),
    node: { path: process.execPath, version: process.version },
    phases: [],
    cli_commands: [],
  };
}

export async function preserveCliArchive(archive, report) {
  const bytes = await readFile(archive);
  const path = join(report.directory, basename(archive));
  await writeFile(path, bytes, { flag: 'wx' });
  report.archive = { source_path: archive, path, bytes: bytes.length, sha256: digest(bytes) };
}

export async function preserveCliBindings(configuration, report) {
  const bytes = await readFile(configuration.path);
  const path = join(report.directory, 'operation-bindings.json');
  await writeFile(path, bytes, { flag: 'wx' });
  report.binding_configuration = {
    ...configuration,
    retained_path: path,
    bytes: bytes.length,
    sha256: digest(bytes),
  };
}

export async function captureNpxRuntime(cache, report, phase) {
  const archive = await identity(report.archive.source_path);
  assert.equal(archive.sha256, report.archive.sha256, '本次实际执行归档不得在打包后改变');
  const candidates = [];
  for (const entry of await readdir(join(cache, '_npx'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(cache, '_npx', entry.name, 'node_modules', '@deviceforge', 'cli');
    try {
      const descriptor = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (descriptor.name === '@deviceforge/cli') candidates.push(root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.equal(candidates.length, 1, '独立本次缓存只允许一份CLI运行包');
  const packageRoot = candidates[0];
  const runtime = await loadRuntime(packageRoot);
  const files = await Promise.all(
    [
      join(packageRoot, 'package.json'),
      join(packageRoot, 'runtime', 'manifest.json'),
      runtime.binary,
      runtime.validator,
      join(runtime.web, 'assets', 'plugin-host.js'),
    ].map(identity),
  );
  const resources = files.map((file) => ({
    ...file,
    relative_path: relative(packageRoot, file.path).replaceAll('\\', '/'),
  }));
  const snapshot = digest(
    Buffer.from(
      resources
        .map((file) => `${file.relative_path}:${file.sha256}`)
        .sort()
        .join('\n') + '\n',
    ),
  );
  if (report.phases.length)
    assert.equal(snapshot, report.phases[0].resources_sha256, '两阶段必须执行同一份缓存资源');
  const entry = {
    phase,
    started_at: new Date().toISOString(),
    package_root: packageRoot,
    archive_sha256: archive.sha256,
    archive_path: archive.path,
    resources,
    resources_sha256: snapshot,
  };
  report.phases.push(entry);
  entry.archive_cache = await verifyArchiveCache(
    report.archive.path,
    packageRoot,
    resources,
    report.archive.sha256,
  );
  return entry;
}

export async function verifyServedHost(base, phase) {
  const response = await fetch(`${base}/assets/plugin-host.js`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = phase.resources.find(
    (file) => file.relative_path === 'runtime/web/assets/plugin-host.js',
  );
  assert.equal(digest(bytes), expected.sha256, '在线前端宿主必须对应本次实际缓存资源');
  phase.served_host = { bytes: bytes.length, sha256: digest(bytes) };
}

// 清理前先保留失败状态；后续清理超时或日志收集失败不抹掉首轮证据。
export async function checkpointCliFailure(report) {
  const path = join(report.directory, 'failure-before-cleanup.json');
  await writeFile(
    path,
    `${JSON.stringify(
      { ...report, checkpoint_at: new Date().toISOString(), cleanup_pending: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return path;
}

export async function finishCliEvidence(report, dataDirectory, token) {
  report.completed_at = new Date().toISOString();
  report.logs ??= [];
  if (dataDirectory) {
    report.logs = [];
    try {
      for (const name of (await readdir(join(dataDirectory, 'logs')))
        .filter((name) => name.endsWith('.jsonl'))
        .sort()) {
        const path = join(dataDirectory, 'logs', name);
        const bytes = await readFile(path);
        const entry = { source_path: path, bytes: bytes.length, sha256: digest(bytes) };
        // 失败报告保留日志副本，但任何凭据都先移除，原字节摘要与副本摘要分别记录。
        if (!report.passed) {
          const retained = Buffer.from(bytes.toString('utf8').replaceAll(token, '[凭据已移除]'));
          entry.retained_path = join(report.directory, name);
          await writeFile(entry.retained_path, retained);
          entry.retained_sha256 = digest(retained);
        }
        report.logs.push(entry);
      }
    } catch (error) {
      report.passed = false;
      report.log_index_error = { name: error.name, code: error.code };
    }
  }
  const path = join(report.directory, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
