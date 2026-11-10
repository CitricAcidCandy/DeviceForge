import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { HostError as compatibilityError } from '../src/plugin-sdk/index.ts';
import { HostError as publicError } from '@deviceforge/plugin-sdk';

const frontend = resolve(import.meta.dirname, '..');
const repository = resolve(frontend, '..');
const frontendRequire = createRequire(join(frontend, 'package.json'));
const release = 'https://github.com/CitricAcidCandy/DeviceForge-SDK/releases/download/v0.1.0/';
const packages = new Map([
  ['@deviceforge/plugin-sdk', 'deviceforge-plugin-sdk-0.1.0.tgz'],
  ['@deviceforge/plugin-tools', 'deviceforge-plugin-tools-0.1.1.tgz'],
  ['@deviceforge/contracts', 'deviceforge-contracts-0.1.0.tgz'],
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function json(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(record(value), '开发清单或锁文件必须是对象');
  return value;
}

async function manifests(): Promise<readonly string[]> {
  const result = [join(frontend, 'package.json')];
  for (const parent of [join(frontend, 'plugins'), join(repository, 'examples')]) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) result.push(join(parent, entry.name, 'package.json'));
    }
  }
  return result;
}

test('SDK远端依赖：所有宿主开发清单固定公开TGZ，不依赖同级源码检出', async () => {
  const seen = new Set<string>();
  for (const path of await manifests()) {
    let metadata: Record<string, unknown>;
    try { metadata = await json(path); }
    catch (error) {
      if (record(error) && error['code'] === 'ENOENT') continue;
      throw error;
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = metadata[section];
      if (dependencies === undefined) continue;
      assert.ok(record(dependencies));
      for (const [name, filename] of packages) {
        if (!(name in dependencies)) continue;
        seen.add(name);
        assert.equal(dependencies[name], release + filename,
          `${relative(repository, path)} 的 ${name} 必须从已公开的固定发行物取得`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...packages.keys()].sort());
});

test('SDK远端依赖：正常安装锁定远端摘要，三个公共包不再是外部目录链接', async () => {
  const lock = await json(join(frontend, 'package-lock.json'));
  assert.ok(record(lock['packages']));
  for (const [name, filename] of packages) {
    const entry: unknown = lock['packages'][`node_modules/${name}`];
    assert.ok(record(entry), `锁文件缺少 ${name}`);
    assert.equal(entry['resolved'], release + filename);
    assert.equal(entry['link'], undefined, `${name} 不能再依靠另一个本地仓库`);
    assert.match(String(entry['integrity']), /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const installed = await realpath(join(frontend, 'node_modules', name));
    const path = relative(frontend, installed);
    assert.ok(!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`),
      `${name} 必须由本工程正常安装，不能解析到相邻检出`);
  }
});

test('SDK远端依赖：公开主入口和三个子入口实际可载入，兼容入口共享错误身份', async () => {
  assert.equal(compatibilityError, publicError);
  for (const name of ['@deviceforge/plugin-sdk', '@deviceforge/plugin-sdk/json',
    '@deviceforge/plugin-sdk/models', '@deviceforge/plugin-sdk/slots']) {
    const module: unknown = await import(pathToFileURL(frontendRequire.resolve(name)).href);
    assert.ok(record(module), `${name} 必须是可载入的已发行ESM`);
  }
});

test('SDK远端依赖：七份组合专项配置不能把公开说明符映射回宿主兼容入口', async () => {
  const configurations = [
    'tsconfig.plugin-composition.json',
    'tests/tsconfig.device-views.json',
    'tests/tsconfig.mirroring-start-feedback.json',
    'tests/tsconfig.official-business.json',
    'plugins/marketplace/tests/tsconfig.json',
    'plugins/settings/tests/tsconfig.json',
    'plugins/tasks/tests/tsconfig.json',
  ];
  const compatibilityDirectory = join(frontend, 'src/plugin-sdk');
  for (const configuration of configurations) {
    const path = join(frontend, configuration);
    const metadata = await json(path);
    const options = metadata['compilerOptions'];
    if (options === undefined) continue;
    assert.ok(record(options));
    const paths = options['paths'];
    if (paths === undefined) continue;
    assert.ok(record(paths));
    const base = resolve(dirname(path), typeof options['baseUrl'] === 'string' ? options['baseUrl'] : '.');
    for (const [specifier, targets] of Object.entries(paths)) {
      if (specifier !== '@deviceforge/plugin-sdk' && !specifier.startsWith('@deviceforge/plugin-sdk/')) continue;
      assert.ok(Array.isArray(targets));
      for (const rawTarget of targets) {
        const target: unknown = rawTarget;
        assert.ok(typeof target === 'string');
        const location = relative(compatibilityDirectory, resolve(base, target));
        assert.ok(isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`),
          `${configuration} 的 ${specifier} 会让兼容转发再次解析到自身`);
      }
    }
  }
});

test('SDK远端依赖：隔离Vite扫描实际兼容入口并预构建四个公开模块', { timeout: 30000 }, async () => {
  const { createLogger, optimizeDeps, resolveConfig } = await import('vite');
  const artifacts = join(frontend, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'sdk-remote-scan-'));
  try {
    const entry = join(directory, 'consumer.js');
    await writeFile(entry, [
      'export * from "@deviceforge/plugin-sdk";',
      'export * from "../../src/plugin-sdk/json.ts";',
      'export * from "../../src/plugin-sdk/models.ts";',
      'export * from "../../src/plugin-sdk/slots.ts";',
    ].join('\n'), 'utf8');
    const errors: string[] = [];
    const logger = createLogger('silent');
    logger.error = (message) => { errors.push(message); };
    const config = await resolveConfig({
      root: frontend, configFile: false, envFile: false, logLevel: 'silent', customLogger: logger,
      cacheDir: join(directory, '.vite'),
      optimizeDeps: { entries: [entry.replaceAll('\\', '/')], noDiscovery: false, force: true },
    }, 'serve');
    const metadata = await optimizeDeps(config, true);
    assert.deepEqual(errors, [], '原无法解析依赖必须在真实Vite扫描中消失');
    for (const name of ['@deviceforge/plugin-sdk', '@deviceforge/plugin-sdk/json',
      '@deviceforge/plugin-sdk/models', '@deviceforge/plugin-sdk/slots']) {
      const optimized = metadata.optimized[name];
      assert.ok(optimized, `${name} 必须实际进入隔离预构建结果`);
      assert.ok(optimized.src, `${name} 必须记录实际发行模块来源`);
      assert.match(optimized.src.replaceAll('\\', '/'), /\/frontend\/node_modules\/@deviceforge\/plugin-sdk\/lib\//);
    }
  } finally {
    const checked = await realpath(directory), expectedParent = await realpath(artifacts);
    assert.equal(dirname(checked), expectedParent, '只回收本次G盘直接子夹具');
    assert.ok(checked.startsWith(join(expectedParent, 'sdk-remote-scan-')));
    await rm(checked, { recursive: true, force: true });
  }
});
