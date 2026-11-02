import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { readWorkspaceBuildTool } from '../scripts/workspace-build-tool.ts';

async function fixture(unit: test.TestContext) {
  const parent = await realpath(tmpdir()), frontend = await mkdtemp(join(parent, 'workspace-build-tool-'));
  unit.after(async () => {
    const checked = await realpath(frontend);
    assert.equal(dirname(checked), parent);
    assert.ok(basename(checked).startsWith('workspace-build-tool-'));
    await rm(checked, { recursive: true, force: true });
  });
  const root = join(frontend, 'plugin-tools');
  await mkdir(join(root, 'dist'), { recursive: true });
  return {
    frontend, root,
    async metadata(value: unknown) { await writeFile(join(root, 'package.json'), JSON.stringify(value)); },
    async archive(version: string, text: string) {
      const path = join(root, 'dist', `deviceforge-plugin-tools-${version}.tgz`);
      await writeFile(path, text); return path;
    },
  };
}

test('工具版本0.1.1从当前元数据读取，保留0.1.0归档且不误用其字节', async (unit) => {
  const f = await fixture(unit);
  await f.metadata({ name: '@deviceforge/plugin-tools', version: '0.1.1' });
  const previous = await f.archive('0.1.0', '旧工具字节');
  const current = await f.archive('0.1.1', '本轮工具字节');
  const tool = await readWorkspaceBuildTool(f.frontend);
  assert.equal(tool.name, '@deviceforge/plugin-tools');
  assert.equal(tool.version, '0.1.1');
  assert.equal(tool.archive, current);
  assert.equal(tool.content.toString('utf8'), '本轮工具字节');
  assert.equal(await readFile(previous, 'utf8'), '旧工具字节');
});

test('原0.1.0及完整预发布构建标识保持精确发行版本', async (unit) => {
  const f = await fixture(unit);
  for (const version of ['0.1.0', '1.2.3-rc.1+build.007']) {
    await f.metadata({ name: '@deviceforge/plugin-tools', version });
    const archive = await f.archive(version, `版本${version}`);
    const tool = await readWorkspaceBuildTool(f.frontend);
    assert.equal(tool.version, version);
    assert.equal(tool.archive, archive);
    assert.equal(tool.content.toString('utf8'), `版本${version}`);
  }
});

test('缺失或非法工具元数据明确失败，不猜版本或选择旧归档', async (unit) => {
  const f = await fixture(unit);
  await f.archive('0.1.0', '不可猜用旧工具');
  await assert.rejects(readWorkspaceBuildTool(f.frontend), /构建工具元数据/u);
  await writeFile(join(f.root, 'package.json'), '{"broken":');
  await assert.rejects(readWorkspaceBuildTool(f.frontend), /构建工具元数据/u);
  for (const metadata of [
    null, [], {}, { name: '@deviceforge/other-tool', version: '0.1.0' },
    { name: '@deviceforge/plugin-tools' }, { name: '@deviceforge/plugin-tools', version: 1 },
    ...['v0.1.1', ' 0.1.1', '0.1.1 ', '01.1.1', '1.01.1', '1.1.01',
      '0.1', '1.2.3.4', '1.2.3-01', '1.2.3+..', '>=0.1.0', '../0.1.0', '0.1.0/other']
      .map((version) => ({ name: '@deviceforge/plugin-tools', version })),
  ]) {
    await f.metadata(metadata);
    await assert.rejects(readWorkspaceBuildTool(f.frontend), /构建工具.*(身份|版本)/u);
  }
});

test('对应版本真实归档缺失或不是普通文件时拒绝，不回退旧版本', async (unit) => {
  const f = await fixture(unit);
  await f.metadata({ name: '@deviceforge/plugin-tools', version: '0.1.1' });
  await f.archive('0.1.0', '旧归档');
  await assert.rejects(readWorkspaceBuildTool(f.frontend), /构建工具归档.*0\.1\.1/u);
  await mkdir(join(f.root, 'dist', 'deviceforge-plugin-tools-0.1.1.tgz'));
  await assert.rejects(readWorkspaceBuildTool(f.frontend), /构建工具归档.*普通文件/u);
});
