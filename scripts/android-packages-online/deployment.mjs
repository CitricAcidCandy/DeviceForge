import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { archiveMembers } from '../cli-smoke-archive.mjs';
import { suffixes } from '../android-packages-smoke/deployment.mjs';
import { sha256 } from '../android-packages-smoke/samples.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { poll } from '../device-provider/client.mjs';

export { suffixes };
export const pluginId = 'android-packages';

async function smallJson(path) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 65536);
  return JSON.parse(await readFile(path, 'utf8'));
}

function contained(root, path) {
  const part = relative(resolve(root), resolve(path));
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part), '实际包文件必须位于本次部署内');
}

export async function prepareArchive({ root, directory, archive, expectedSha256, report }) {
  assert.ok(isAbsolute(archive));
  assert.match(expectedSha256, /^[a-f\d]{64}$/);
  const metadata = await lstat(archive);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 64 * 1024 * 1024);
  const bytes = await readFile(archive);
  assert.equal(bytes.length, metadata.size);
  assert.equal(sha256(bytes), expectedSha256, '传入摘要必须对应本次原TGZ压缩字节');
  const retainedPath = join(directory, 'original-plugin.tgz');
  await writeFile(retainedPath, bytes, { flag: 'wx' });
  const original = { path: archive, bytes: bytes.length, sha256: expectedSha256 };
  const retained = await fileIdentity(retainedPath);
  assert.equal(retained.sha256, expectedSha256);
  assert.equal(retained.bytes, bytes.length);
  report.archive = {
    original,
    retained,
    supplied_sha256: expectedSha256,
    plugin_build: '主代理正式原TGZ；--release仅选择宿主，不重建或替换包内插件',
    compressed_bytes_preserved: true,
  };
  // 使用已有有界只读TAR检查，不重打包、不运行安装脚本或原生构建helper。
  const members = await archiveMembers(retainedPath, expectedSha256);
  assert.ok(members.length <= 256 && members.every((member) => member.bytes <= 64 * 1024 * 1024));
  assert.equal(
    new Set(members.map((member) => member.relative_path.toLowerCase())).size,
    members.length,
  );
  assert.ok(
    !members.some((member) => member.relative_path === 'manifest.json'),
    '当前正式native包以独立plugin.json保留便携声明；manifest.json留给安装器生成',
  );
  report.archive.members = members;
  const source = join(root, 'backend/plugins/android-packages');
  const sourcePaths = ['manifest.json', 'manifest.example.json', 'aliases.example.json'].map(
    (name) => join(source, name),
  );
  const [manifest, example, aliases] = await Promise.all(sourcePaths.map(smallJson));
  assert.deepEqual(manifest, example);
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.args, []);
  assert.deepEqual(
    manifest.operations.map((entry) => entry.name),
    suffixes,
  );
  assert.equal(aliases.format_version, 1);
  assert.equal(aliases.bindings.length, 7);
  for (const [index, binding] of aliases.bindings.entries()) {
    assert.equal(binding.operation.id, `android.package.${suffixes[index]}`);
    assert.deepEqual(binding.target, {
      kind: 'operation',
      plugin_id: pluginId,
      operation: `plugin.${pluginId}.${suffixes[index]}`,
    });
    assert.equal(binding.input, 'identity');
    assert.equal(binding.result.wrapped, true);
    assert.deepEqual(binding.operation.input_schema, manifest.operations[index].input_schema);
  }
  const sourceIdentities = await Promise.all(sourcePaths.map(fileIdentity));
  const bindingsPath = join(directory, 'operation-bindings.json');
  await writeFile(bindingsPath, await readFile(sourcePaths[2]), { flag: 'wx' });
  const bindings = await fileIdentity(bindingsPath);
  assert.equal(bindings.sha256, sourceIdentities[2].sha256);
  report.bindings = {
    path: bindingsPath,
    identity: bindings,
    source_identities: sourceIdentities,
    scope: '本次空宿主显式七alias配置；不是改包或向插件注入工具配置',
  };
  return {
    bytes,
    archive,
    expectedSha256,
    retainedPath,
    members,
    manifest,
    bindingsPath,
    sourceIdentities,
    bindings,
  };
}

// 原TGZ所有普通成员都保持原字节；安装器另生成运行清单与包视图。
export async function snapshotDeployment(directory) {
  const output = [];
  const visit = async (folder, depth) => {
    assert.ok(depth <= 8);
    for (const item of await readdir(folder, { withFileTypes: true })) {
      assert.ok(output.length < 512 && !item.isSymbolicLink());
      const path = join(folder, item.name),
        name = relative(directory, path).replaceAll('\\', '/');
      if (item.isDirectory()) {
        output.push({ path: name, directory: true });
        await visit(path, depth + 1);
      } else {
        assert.ok(item.isFile());
        const identity = await fileIdentity(path);
        output.push({ path: name, bytes: identity.bytes, sha256: identity.sha256 });
      }
    }
  };
  await visit(directory, 0);
  return output.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function settledRoot(directory) {
  return poll(
    async () => {
      try {
        // 安装响应后暂存删除仍可能在飞；先看目录名，避免读取正在删除的暂存程序。
        const entries = await readdir(directory, { withFileTypes: true });
        if (
          entries.some(
            (entry) => entry.name.startsWith('.package-') || entry.name.startsWith('.removed-'),
          )
        )
          return undefined;
        const snapshot = [];
        for (const entry of entries) {
          const path = join(directory, entry.name);
          assert.ok(!entry.isSymbolicLink());
          if (entry.name === '.packages.lock') {
            // 宿主运行期间独占此协调锁；它不是包成员，不读取被锁定的字节。
            const metadata = await lstat(path);
            assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
            snapshot.push({ path: entry.name, coordination_lock: true });
          } else {
            assert.ok(entry.isDirectory(), '插件根只接受部署目录及宿主协调锁');
            snapshot.push({ path: entry.name, directory: true });
            for (const member of await snapshotDeployment(path))
              snapshot.push({ ...member, path: `${entry.name}/${member.path}` });
          }
        }
        return snapshot;
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    (snapshot) =>
      snapshot !== undefined &&
      snapshot.every(
        (entry) =>
          !entry.path
            .split('/')
            .some((part) => part.startsWith('.package-') || part.startsWith('.removed-')),
      ),
    '本次安装暂存与删除暂存收敛',
    5000,
  );
}

export async function verifyInstalled(host, context, info, report) {
  const directory = join(host.plugins, pluginId),
    root = await realpath(directory);
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  report.deployment = {
    directory,
    matched_members: [],
    config_injected: false,
    direct_plugin_pid_observed: false,
    pid_boundary: '四个无工具Job未直接采插件OS PID；只采实际宿主PID与插件调用日志',
  };
  for (const member of context.members) {
    const path = join(directory, ...member.relative_path.split('/'));
    const metadata = await lstat(path);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    contained(root, await realpath(path));
    const identity = await fileIdentity(path);
    assert.equal(identity.bytes, member.bytes, `安装成员长度：${member.relative_path}`);
    assert.equal(identity.sha256, member.sha256, `安装成员原TGZ摘要：${member.relative_path}`);
    report.deployment.matched_members.push({ ...identity, relative_path: member.relative_path });
  }
  const descriptor = await smallJson(join(directory, 'package.json'));
  assert.equal(descriptor.deviceforge.kind, 'server');
  assert.equal(descriptor.deviceforge.manifest, 'plugin.json');
  const platform = `${process.platform}-${process.arch}`,
    entry = descriptor.deviceforge.entrypoints[platform];
  assert.deepEqual(entry, {
    runtime: 'native',
    path: `bin/deviceforge-android-packages-plugin${process.platform === 'win32' ? '.exe' : ''}`,
  });
  assert.ok(
    context.members.some((member) => member.relative_path === descriptor.deviceforge.manifest),
  );
  assert.ok(context.members.some((member) => member.relative_path === entry.path));
  const portable = await smallJson(join(directory, descriptor.deviceforge.manifest));
  assert.deepEqual(portable, context.manifest, '原包便携声明与当前源双清单语义相同');
  assert.equal(descriptor.version, portable.version);
  assert.equal(info.version, portable.version);
  assert.deepEqual(Object.keys(info).sort(), [
    'api_version',
    'entry_path',
    'entry_url',
    'id',
    'installed_at',
    'kind',
    'runtime',
    'version',
  ]);
  assert.equal(info.id, pluginId);
  assert.equal(info.kind, 'server');
  assert.equal(info.runtime, 'native');
  assert.equal(info.entry_path, entry.path);
  assert.equal(info.entry_url, null);
  assert.equal(info.api_version, null);
  assert.ok(Number.isSafeInteger(info.installed_at) && info.installed_at > 0);
  const generatedPath = join(directory, 'manifest.json'),
    generated = await smallJson(generatedPath);
  for (const field of ['id', 'version', 'protocol_version', 'args', 'operations'])
    assert.deepEqual(generated[field], portable[field]);
  assert.deepEqual(
    { ...generated.artifacts, input_pointers: generated.artifacts?.input_pointers ?? [] },
    portable.artifacts,
  );
  assert.equal(generated.performance ?? null, null);
  assert.equal(generated.devices ?? null, null);
  assert.ok(
    Object.keys(generated).every((key) =>
      [
        'id',
        'version',
        'protocol_version',
        'args',
        'operations',
        'artifacts',
        'performance',
        'devices',
        'executable',
      ].includes(key),
    ),
  );
  const executable = join(directory, ...entry.path.split('/'));
  assert.equal(await realpath(generated.executable), await realpath(executable));
  for (const folder of [directory, join(directory, 'bin')]) {
    await assert.rejects(
      lstat(join(folder, 'android-packages.config.json')),
      { code: 'ENOENT' },
      '本次原包不得注入配置',
    );
  }
  const installedFiles = await snapshotDeployment(directory);
  assert.deepEqual(
    installedFiles
      .filter((file) => !file.directory)
      .map((file) => file.path)
      .sort(),
    [
      ...context.members.map((member) => member.relative_path),
      'manifest.json',
      '.deviceforge-package.json',
    ].sort(),
    '仅允许原包普通成员与安装器两份生成元数据，不忽略额外配置或程序',
  );
  report.deployment = {
    ...report.deployment,
    descriptor,
    portable_manifest: portable,
    generated_manifest: generated,
    generated_manifest_identity: await fileIdentity(generatedPath),
    actual_plugin_binary: await fileIdentity(executable),
    package_info: info,
    original_member_count: context.members.length,
    generated_files: ['manifest.json', '.deviceforge-package.json'],
    installed_snapshot: installedFiles,
    ordinary_protocol_version: portable.protocol_version,
    package_view_api_version_boundary: 'server包视图api_version=null，不能解释为设备或协议版本',
  };
  context.deploymentDirectory = directory;
  context.installedSnapshot = installedFiles;
}

export async function verifyUnchanged(context, report, phase) {
  const snapshot = await snapshotDeployment(context.deploymentDirectory);
  assert.deepEqual(snapshot, context.installedSnapshot, '业务/拒删/装卸不应改原包或生成清单');
  report.deployment.unchanged_phases ??= [];
  report.deployment.unchanged_phases.push({ phase, files: snapshot.length, unchanged: true });
}

export async function verifyArchiveIdentity(context, report) {
  report.archive.identities_after = [];
  for (const path of [context.archive, context.retainedPath]) {
    const after = await fileIdentity(path);
    assert.equal(after.sha256, context.expectedSha256);
    assert.equal(after.bytes, context.bytes.length);
    report.archive.identities_after.push(after);
  }
  report.bindings.identities_after = [];
  for (const before of [...context.sourceIdentities, context.bindings]) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.sha256, before.sha256);
    report.bindings.identities_after.push(after);
  }
}
