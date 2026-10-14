import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { sourceContract } from './contracts.mjs';

export async function prepareDeployment(context, snapshot) {
  const manifests = {},
    aliases = [];
  context.scratch = {};
  context.pluginBinaries = {};
  context.deployments = [];
  for (const id of ['android-packages', 'android-device']) {
    const manifest = JSON.parse(await readFile(join(snapshot, id, 'manifest.json'), 'utf8'));
    const example = JSON.parse(await readFile(join(snapshot, id, 'manifest.example.json'), 'utf8'));
    const bindings = JSON.parse(await readFile(join(snapshot, id, 'aliases.example.json'), 'utf8'));
    manifests[id] = manifest;
    aliases.push(...bindings.bindings);
    const scratch = join(context.directory, id + '-scratch');
    const staged = join(context.directory, id + '-staging');
    const published = join(context.directory, 'data/server-plugins', id);
    await mkdir(scratch);
    await mkdir(staged);
    context.scratch[id] = scratch;
    context.pluginBinaries[id] = join(snapshot, 'deviceforge-' + id + '-plugin.exe');
    const configPath = join(published, id + '.config.json');
    const config = {
      format_version: 1,
      tools: {
        java: context.tool.executable,
        bundletool: { kind: 'java_jar', jar: context.tool.jar },
        ...(id === 'android-device' ? { adb: context.tool.executable } : {}),
      },
      scratch_root: scratch,
    };
    const runtime = {
      ...manifest,
      executable: context.pluginBinaries[id],
      args: ['--config', configPath],
    };
    await writeFile(join(staged, 'manifest.json'), JSON.stringify(runtime), { flag: 'wx' });
    await writeFile(join(staged, id + '.config.json'), JSON.stringify(config), { flag: 'wx' });
    if (id === 'android-device') assert.deepEqual(manifest, example);
    context.deployments.push({
      id,
      staged,
      published,
      manifest,
      example_equal: JSON.stringify(manifest) === JSON.stringify(example),
      config_path: configPath,
      actual_binary: await fileIdentity(context.pluginBinaries[id]),
      public_operations: [
        ...manifest.operations.map((value) => 'plugin.' + id + '.' + value.name),
        ...bindings.bindings.map((value) => value.operation.id),
      ],
    });
  }
  const combined = { format_version: 2, bindings: aliases };
  assert.equal(new Set(aliases.map((value) => value.operation.id)).size, aliases.length);
  sourceContract(manifests['android-packages'], manifests['android-device'], combined);
  const bindingsPath = join(context.directory, 'operation-bindings.json');
  await writeFile(bindingsPath, JSON.stringify(combined), { flag: 'wx' });
  context.report.deployment = {
    kind: '独占目录直接部署冻结清单/程序、真实validator与公开load；非TGZ或npx',
    bindings: await fileIdentity(bindingsPath),
    alias_count: aliases.length,
    packages_example_boundary: '包插件示例保留旧四字段，本次部署实际manifest；不将二者写为相同',
  };
  return bindingsPath;
}

export async function publish(context, validator) {
  context.report.deployment.plugins = [];
  for (const deployment of context.deployments) {
    await rename(deployment.staged, deployment.published);
    const path = join(deployment.published, 'manifest.json');
    const result = await new Promise((done, reject) => {
      const child = execFile(
        validator,
        [path],
        { timeout: 15000, maxBuffer: 65536, windowsHide: true },
        (error, stdout, stderr) => {
          const evidence = { pid: child.pid, exit_code: child.exitCode, signal: child.signalCode };
          if (error) {
            reject(error);
            return;
          }
          try {
            assert.deepEqual(evidence, { pid: child.pid, exit_code: 0, signal: null });
            assert.equal(stderr.trim(), '');
            const value = JSON.parse(stdout);
            assert.deepEqual(value, {
              id: deployment.id,
              version: deployment.manifest.version,
              operations: deployment.manifest.operations.length,
            });
            done({ ...evidence, result: value });
          } catch (error) {
            reject(error);
          }
        },
      );
    });
    deployment.identities = await Promise.all([path, deployment.config_path].map(fileIdentity));
    const loaded = await context.host.client.post('/api/v2/plugins/' + deployment.id + '/load');
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    assert.deepEqual([...loaded.operations].sort(), [...deployment.public_operations].sort());
    deployment.generation = loaded.generation;
    context.report.deployment.plugins.push({
      id: deployment.id,
      example_equal: deployment.example_equal,
      generation: loaded.generation,
      identities: deployment.identities,
      binary: deployment.actual_binary,
      validator: result,
    });
  }
  context.report.checks.push({
    name: '冻结双插件实际validator exit0/七与十二贡献及公开load',
    passed: true,
  });
}

export async function verifyDeployment(context) {
  const before = context.deployments.flatMap((value) => [value.actual_binary, ...value.identities]);
  context.report.deployment.identities_after = await Promise.all(
    before.map((value) => fileIdentity(value.path)),
  );
  assert.deepEqual(context.report.deployment.identities_after, before);
}
