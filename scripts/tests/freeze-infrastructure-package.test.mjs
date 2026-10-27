import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { freezeInfrastructurePackage, selectSmokePackageRoot } from '../freeze-infrastructure-package.mjs';
import { inside } from '../../cli/src/paths.mjs';
import { loadRuntime, sha256 } from '../../cli/src/runtime.mjs';

const key = 'DEVICEFORGE_CLI_SMOKE_PACKAGE_ROOT';
const windows = { skip: process.platform !== 'win32' };
const pkg = {
  name: '@deviceforge/cli', version: '0.1.0', type: 'module',
  bin: { deviceforge: 'cli/bin/deviceforge.mjs' },
  files: ['cli/bin', 'cli/src', 'cli/README.md', 'runtime', 'README.md'],
  scripts: { prepack: 'node scripts/verify-package.mjs' },
};

async function write(root, path, value) {
  const target = join(root, path);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, value);
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-infrastructure-unit-'));
  t.after(async () => {
    const target = await realpath(temporary);
    const parent = await realpath(tmpdir());
    assert.ok(inside(parent, target) && target !== parent && basename(target).startsWith('deviceforge-infrastructure-unit-'));
    await rm(target, { recursive: true, force: true });
  });
  for (const [path, value] of Object.entries({
    'package.json': JSON.stringify(pkg, null, 2),
    'README.md': '单元测试根说明，不代表真实构建。',
    'cli/README.md': '单元测试 CLI 说明。',
    'cli/bin/deviceforge.mjs': '// 不执行的单元测试入口\n',
    'cli/src/entry.mjs': '// 不执行的单元测试依赖\n',
    'scripts/verify-package.mjs': '// 仅检验原字节复制，不启动子进程\n',
    'backend/target/release/apk-server.exe': '单元测试后端字节，不是真实 EXE',
    'backend/target/release/validate-plugin.exe': '单元测试校验器字节，不是真实 EXE',
    'frontend/dist/index.html': '<!doctype html><title>单元夹具</title>',
    'frontend/dist/assets/plugin-host.js': 'export const createFrontendRuntime=1,createNamedSlotAdapter=2;',
    'frontend/dist/assets/中文子目录/extra.js': 'export const value=1;',
    'runtime/manifest.json': '{"保持":"旧用户 runtime 原字节"}',
    'runtime/old.exe': '旧用户运行包，不得替换',
    'artifacts/historical-stage/package/keep.txt': '历史 stage 不得删除',
  })) await write(temporary, path, value);
  return temporary;
}

test('未设置内部包目录时保持原源码根', async (t) => {
  const root = await fixture(t);
  assert.equal(await selectSmokePackageRoot(root, {}), root);
});

test('可选绝对包目录只接受相同包名和版本', async (t) => {
  const root = await fixture(t);
  const selected = join(root, '候选包');
  await write(selected, 'package.json', JSON.stringify(pkg));
  assert.equal(await selectSmokePackageRoot(root, { [key]: selected }), await realpath(selected));
});

test('拒绝空值、相对路径、URL、非字符串及 NUL 路径', async (t) => {
  const root = await fixture(t);
  for (const selected of ['', ' ', 'relative', '../runtime', 'file:///tmp/pack', 'https://example.invalid', null, {}, 1, `${root}\0bad`]) {
    await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }), /完整绝对路径/);
  }
});

test('Windows 驱动器相对路径和仅当前盘根路径都不是完整绝对路径', windows, async (t) => {
  const root = await fixture(t);
  for (const selected of ['C:relative', '\\root-relative', '/root-relative']) {
    await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }), /完整绝对路径/);
  }
});

test('拒绝不存在目录和普通文件作为包根', async (t) => {
  const root = await fixture(t);
  await assert.rejects(selectSmokePackageRoot(root, { [key]: join(root, '不存在') }));
  await assert.rejects(selectSmokePackageRoot(root, { [key]: join(root, 'README.md') }), /普通目录/);
});

test('拒绝缺失、损坏或过大的包清单', async (t) => {
  const root = await fixture(t);
  const selected = join(root, '候选包');
  await mkdir(selected);
  await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }));
  for (const value of ['{broken', ' '.repeat(65537)]) {
    await write(selected, 'package.json', value);
    await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }));
  }
});

test('拒绝另一个包名或版本，即使目录本身存在', async (t) => {
  const root = await fixture(t);
  const selected = join(root, '候选包');
  for (const patch of [{ name: '@other/cli' }, { version: '9.9.9' }, { name: null }, { version: null }]) {
    await write(selected, 'package.json', JSON.stringify({ ...pkg, ...patch }));
    await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }), /name\/version/);
  }
});

test('原源码根缺少包身份时不能用相同空值蒙混通过', async (t) => {
  const root = await fixture(t);
  const selected = join(root, '候选包');
  await write(root, 'package.json', '{}');
  await write(selected, 'package.json', '{}');
  await assert.rejects(selectSmokePackageRoot(root, { [key]: selected }), /缺少有效/);
});

test('拒绝目录联接作为包根', windows, async (t) => {
  const root = await fixture(t);
  const linked = join(root, '联接包');
  await symlink(join(root, 'cli'), linked, 'junction');
  await assert.rejects(selectSmokePackageRoot(root, { [key]: linked }), /非链接普通目录/);
});

test('冻结当前指定输入、原格式清单与能力，根 runtime 和历史 stage 原字节不变', windows, async (t) => {
  const root = await fixture(t);
  const protectedFiles = ['runtime/manifest.json', 'runtime/old.exe', 'artifacts/historical-stage/package/keep.txt'];
  const original = await Promise.all(protectedFiles.map((path) => readFile(join(root, path))));
  const { packRoot, reportPath, report } = await freezeInfrastructurePackage(root);
  assert.ok(inside(join(root, 'artifacts'), packRoot));
  assert.notEqual(packRoot, root);
  assert.equal(report.passed, true);
  assert.equal(report.source_fingerprint, report.source_fingerprint_after);
  assert.match(report.package_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).packRoot, packRoot);
  assert.deepEqual(JSON.parse(await readFile(join(packRoot, 'package.json'), 'utf8')), pkg);
  for (const file of report.sources) {
    assert.deepEqual(await readFile(join(packRoot, file.path)), await readFile(join(root, file.source)));
    assert.equal(await sha256(join(packRoot, file.path)), file.sha256);
  }
  const manifest = JSON.parse(await readFile(join(packRoot, 'runtime/manifest.json'), 'utf8'));
  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.profile, 'release');
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.capabilities, ['plugin_dependencies_v1']);
  assert.equal(manifest.web, 'web');
  assert.equal(manifest.platforms[0].backend, `${process.platform}-${process.arch}/apk-server.exe`);
  assert.equal(manifest.platforms[0].validator, `${process.platform}-${process.arch}/validate-plugin.exe`);
  assert.equal((await loadRuntime(packRoot)).dependencyPreparation, true);
  for (let i = 0; i < protectedFiles.length; i += 1) {
    assert.deepEqual(await readFile(join(root, protectedFiles[i])), original[i]);
  }
  await assert.rejects(lstat(join(packRoot, 'backend')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(packRoot, 'frontend')), { code: 'ENOENT' });
});

test('连续冻结产生不同 stage，不能覆盖或删除前一次候选', windows, async (t) => {
  const root = await fixture(t);
  const first = await freezeInfrastructurePackage(root);
  const second = await freezeInfrastructurePackage(root);
  assert.notEqual(first.packRoot, second.packRoot);
  assert.equal(first.report.package_fingerprint, second.report.package_fingerprint);
  assert.equal((await lstat(first.reportPath)).isFile(), true);
});

test('缺少 release EXE 时失败，不用根 runtime 或其他构建回退', windows, async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'backend/target/release/validate-plugin.exe'));
  await assert.rejects(freezeInfrastructurePackage(root), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'artifacts')), ['historical-stage']);
});

test('公开浏览器宿主入口无效时保留失败 stage 和报告', windows, async (t) => {
  const root = await fixture(t);
  await write(root, 'frontend/dist/assets/plugin-host.js', '不具备公开入口');
  await assert.rejects(freezeInfrastructurePackage(root), /保留本次 stage.*公开浏览器宿主入口/);
  const names = (await readdir(join(root, 'artifacts'))).filter((name) => name.startsWith('infrastructure-package-'));
  assert.equal(names.length, 1);
  const report = JSON.parse(await readFile(join(root, 'artifacts', names[0], 'freeze-report.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert.equal((await lstat(report.packRoot)).isDirectory(), true);
});

test('复制期间已有输入变化必须失败，不能交付混合字节', windows, async (t) => {
  const root = await fixture(t);
  let changed = false;
  await assert.rejects(freezeInfrastructurePackage(root, {
    copy: async (source, destination) => {
      await copyFile(source, destination);
      if (source.endsWith(join('frontend', 'dist', 'index.html'))) {
        await write(root, 'cli/README.md', '模拟另一角色在冻结期间修改输入');
        changed = true;
      }
    },
  }), /冻结期间源码或构建产物漂移/);
  assert.equal(changed, true);
  const names = (await readdir(join(root, 'artifacts'))).filter((name) => name.startsWith('infrastructure-package-'));
  const report = JSON.parse(await readFile(join(root, 'artifacts', names[0], 'freeze-report.json'), 'utf8'));
  assert.notEqual(report.source_fingerprint, report.source_fingerprint_after);
  assert.equal(report.passed, false);
});

test('冻结期间新增输入文件也必须失败，不能悄悄漏装', windows, async (t) => {
  const root = await fixture(t);
  await assert.rejects(freezeInfrastructurePackage(root, {
    copy: async (source, destination) => {
      await copyFile(source, destination);
      if (source.endsWith(join('frontend', 'dist', 'index.html'))) {
        await write(root, 'cli/src/new.mjs', '// 冻结期间新增\n');
      }
    },
  }), /冻结期间源码或构建产物漂移/);
});

test('输入目录联接不能越过冻结文件边界', windows, async (t) => {
  const root = await fixture(t);
  await symlink(join(root, 'runtime'), join(root, 'frontend/dist/外来目录'), 'junction');
  await assert.rejects(freezeInfrastructurePackage(root), /不能包含符号链接或目录联接/);
});

test('CLI smoke 仅替换 npm pack 的 cwd，原生夹具和证据仍绑定源码根', async () => {
  const source = (await readFile(new URL('../cli-smoke.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(source.includes('const packRoot = await selectSmokePackageRoot(root);'));
  assert.ok(source.includes('{ cwd: packRoot, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120000 }'));
  assert.ok(source.includes('createCliEvidence(root, temporary)'));
  assert.ok(source.includes('await installNativePlugins({\n    root,'));
  assert.ok(source.includes('await configureOrdinaryNpx({ root, temporary, pluginDirectory })'));
});
