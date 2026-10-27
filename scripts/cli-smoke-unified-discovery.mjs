import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, events } from './unified-discovery/fixtures.mjs';
import { configure, providers } from './cli-smoke-unified-discovery/config.mjs';
import { clientFor } from './cli-smoke-unified-discovery/client.mjs';
import {
  invalidRaw,
  noDirectory,
  oneDiscovery,
  registrations,
} from './cli-smoke-unified-discovery/checks.mjs';
import { verifyHistories, verifyReload } from './cli-smoke-unified-discovery/lifecycle.mjs';
import { removeOfflineFixture } from './cli-smoke-unified-discovery/cleanup.mjs';

export const configureNpxUnifiedDiscovery = configure;

// 调用方负责真实npx宿主与报告保存；此函数只安装本批两个包并验证公开边界。
export async function verifyNpxUnifiedDiscovery({
  root,
  temporary,
  pluginDirectory,
  runNpx,
  prefix,
  dataDirectory,
  base,
  mcp,
  headers,
}) {
  assert.equal(typeof root, 'string');
  assert.equal(typeof runNpx, 'function');
  assert.ok(Array.isArray(prefix));
  const phaseId = randomUUID();
  const phaseDirectory = join(resolve(temporary), 'unified-discovery-npx', phaseId);
  const evidence = {
    schemaVersion: 1,
    phaseId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    passed: false,
    packages: [],
    entries: [],
    logIds: [],
    providerIds: providers.map((item) => item.id),
    history: [],
    reloads: [],
    rejections: [],
    cleanup: [],
  };
  const client = clientFor({ base, mcp, headers, evidence });
  const context = { client, evidence, histories: new Map(), items: [] };
  let stage = 'prepare';
  try {
    await mkdir(phaseDirectory, { recursive: true });
    for (const declaration of providers) {
      stage = `install:${declaration.id}`;
      const item = await fixture(declaration.id, phaseDirectory, {
        protocol: declaration.protocol,
        devicesApiVersion: 3,
        platform: declaration.platform,
      });
      item.alias = declaration.alias;
      context.items.push(item);
      await registrations(client, item, false);
      const path = join(phaseDirectory, `${item.id}.tgz`);
      await writeFile(path, item.tgz, { flag: 'wx' });
      const before = await readFile(path);
      const sha256 = createHash('sha256').update(before).digest('hex');
      assert.equal(sha256, item.sha256, '安装文件必须是本次构包的原字节');
      const installed = await runNpx([
        ...prefix,
        'plugin',
        'install-legacy',
        path,
        '--data-dir',
        dataDirectory,
      ]);
      assert.equal(installed.code ?? 0, 0, 'runNpx必须真实零退出');
      assert.ok(installed.stdout.includes(`${item.id}@1.0.0 安装完成`));
      assert.deepEqual(await readFile(path), before, '实际安装过程不得换掉证据归档');
      assert.deepEqual(await events(item), [], '构包与CLI安装不得执行插件');
      evidence.packages.push({
        id: item.id,
        protocol: item.protocol,
        devicesApiVersion: 3,
        platform: item.platform,
        controlDirectory: item.controlDirectory,
        tgz: { path, bytes: before.length, sha256 },
        install: {
          command: 'npx deviceforge plugin install',
          exitCode: 0,
          installedVersion: '1.0.0',
        },
      });
      await registrations(client, item, false);
      stage = `load:${item.id}`;
      const loaded = await client.manage(item.id, 'load', item.protocol === 2 ? 'http' : 'mcp');
      assert.equal(loaded.state, 'loaded');
      assert.equal(loaded.cleanup_failed, false);
      item.provider = await registrations(client, item, true);
      assert.equal(item.provider.generation, loaded.generation);
      await noDirectory(client, item);
      assert.deepEqual(await events(item), [], '加载只发布声明，不自动发现');
    }

    const scenes = [
      { entry: 'refresh', transport: 'http', rawCase: 'recovery' },
      { entry: 'refresh', transport: 'mcp', rawState: '  Vendor:未识别  ' },
      { entry: 'direct', transport: 'http', rawCase: 'sideload' },
      { entry: 'direct', transport: 'mcp', rawCase: 'bootloader' },
      { entry: 'alias', transport: 'http', rawCase: 'utf8-100' },
      { entry: 'alias', transport: 'mcp', rawCase: 'valid' },
    ];
    for (const item of context.items) {
      for (const scene of scenes) {
        stage = `${item.id}:${scene.entry}:${scene.transport}`;
        await oneDiscovery(context, item, {
          ...scene,
          label: `${item.platform}_${scene.entry}_${scene.transport}`,
        });
      }
      stage = `${item.id}:invalid-raw`;
      await invalidRaw(context, item);
      stage = `${item.id}:reload`;
      await verifyReload(context, item);
    }
    assert.equal(
      evidence.entries.filter((entry) => ['refresh', 'direct', 'alias'].includes(entry.entry))
        .length,
      14,
    );
    stage = 'history-before-delete';
    await verifyHistories(context);
    for (const item of context.items) {
      stage = `cleanup:${item.id}`;
      const unloaded = await client.manage(item.id, 'unload', item.protocol === 2 ? 'http' : 'mcp');
      assert.equal(unloaded.state, 'unloaded');
      assert.equal(unloaded.cleanup_failed, false);
      await registrations(client, item, false);
      await noDirectory(client, item);
      const removal = await removeOfflineFixture({
        temporary,
        pluginDirectory,
        id: item.id,
        client,
      });
      const packages = await client.json('/api/v2/plugin-packages/server');
      assert.ok(!packages.some((entry) => entry.id === item.id));
      evidence.cleanup.push({
        providerId: item.id,
        unloaded: true,
        cleanupFailed: false,
        contributionsRevoked: true,
        directoryRevoked: true,
        ...removal,
        scope:
          '只删除本阶段已卸载的临时CLI离线部署，保留TGZ、控制与历史证据；不代表在线卸载API或CLI卸载命令',
      });
    }
    stage = 'history-after-delete';
    evidence.history = [];
    await verifyHistories(context);
    evidence.passed = true;
    return evidence;
  } catch (error) {
    // 不输出headers、环境、CLI任意stdout/stderr或错误正文；调用方决定保存与保留临时目录。
    evidence.failure = {
      stage,
      errorName: error.name,
      request: client.diagnostic.failedRequest ?? client.diagnostic.lastRequest,
    };
    error.unifiedDiscoveryEvidence = evidence;
    throw error;
  } finally {
    evidence.completedAt = new Date().toISOString();
    evidence.logIds = [...client.logIds].sort();
  }
}
