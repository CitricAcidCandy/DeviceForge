import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { packPlugin } from '../src/plugin-authoring/pack.mjs';
import { parseOptions } from '../src/options.mjs';
import { runAuthoring } from '../src/plugin-authoring/commands.mjs';

async function fixture(unit) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'deviceforge-prepared-'));
  unit.after(async () => {
    const checked = await realpath(root);
    assert.equal(dirname(checked), parent); assert.ok(basename(checked).startsWith('deviceforge-prepared-'));
    await rm(checked, { recursive: true, force: true });
  });
  await writeFile(join(root, 'index.js'), 'export default () => ({apiVersion:2,panels:[]});');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 1, id: 'example', version: '1.0.0',
    name: '准备测试', description: '验证可接续目录提交。', components: [{ kind: 'browser', files: ['index.js'],
      entrypoints: { any: { runtime: 'browser', path: 'index.js' } } }] }));
  return { root, source: join(root, 'manifest.json'), destination: join(root, 'published') };
}

test('准备只生成可核对暂存，后续提交不重新打包且重复观察返回同一完成结果', async (unit) => {
  const f = await fixture(unit);
  const prepared = await packPlugin({ ...f, prepareOnly: true });
  assert.equal(prepared.state, 'prepared'); assert.equal(typeof prepared.receipt, 'string');
  assert.equal((await readdir(f.root)).includes('published'), false);
  const report = await runAuthoring({ command: 'plugin.finalize', receipt: prepared.receipt });
  assert.equal(report.id, 'example'); assert.equal(report.state, 'completed');
  const again = await runAuthoring({ command: 'plugin.finalize', receipt: prepared.receipt });
  assert.equal(again.sha256, report.sha256); assert.equal(again.revision, report.revision);
  assert.equal((await readFile(report.archive)).length, report.size);
});

test('准备后文件改动或增加、目标冲突均拒绝提交，保留暂存不覆盖原目标', async (unit) => {
  const f = await fixture(unit);
  const prepared = await packPlugin({ ...f, prepareOnly: true });
  const receipt = JSON.parse(await readFile(prepared.receipt, 'utf8'));
  await writeFile(join(receipt.staging, 'unexpected.txt'), '额外文件');
  await assert.rejects(runAuthoring({ command: 'plugin.finalize', receipt: prepared.receipt }), /成员|文件|身份/);
  assert.equal((await readdir(f.root)).includes('published'), false);
  await rm(join(receipt.staging, 'unexpected.txt'));
  await mkdir(f.destination); await writeFile(join(f.destination, 'other.txt'), '他人内容');
  await assert.rejects(runAuthoring({ command: 'plugin.finalize', receipt: prepared.receipt }), /已存在|冲突/);
  assert.equal(await readFile(join(f.destination, 'other.txt'), 'utf8'), '他人内容');
});

test('准备与提交参数明确区分完成状态，取消不删除可继续核对的暂存', async (unit) => {
  const f = await fixture(unit);
  const options = parseOptions(['plugin', 'pack', f.source, '--out', f.destination, '--prepare-only', 'true']);
  assert.equal(options.prepareOnly, true);
  const prepared = await packPlugin(options);
  const finalize = parseOptions(['plugin', 'finalize', prepared.receipt]);
  assert.equal(finalize.command, 'plugin.finalize');
  await assert.rejects(runAuthoring(finalize, { signal: AbortSignal.abort(new Error('本次取消')) }), /取消/);
  assert.equal(JSON.parse(await readFile(prepared.receipt, 'utf8')).state, 'prepared');
  assert.throws(() => parseOptions(['plugin', 'pack', '--prepare-only', 'maybe']), /参数|true|false/);
  assert.throws(() => parseOptions(['plugin', 'finalize', prepared.receipt, '--out', f.destination]), /参数/);
});
