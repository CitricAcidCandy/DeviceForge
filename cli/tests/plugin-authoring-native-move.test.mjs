import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { movePluginDirectory } from '../src/plugin-authoring/native-move.mjs';

async function fixture(unit) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'deviceforge-native-move-'));
  unit.after(async () => {
    const checked = await realpath(root);
    assert.equal(dirname(checked), parent); assert.ok(basename(checked).startsWith('deviceforge-native-move-'));
    await rm(checked, { recursive: true, force: true });
  });
  const source = join(root, '.deviceforge-pack-Abc123'), target = join(root, 'published');
  await mkdir(source); await writeFile(join(source, 'marker.json'), '{"owned":true}');
  return { source, target };
}
const denied = async () => { throw Object.assign(new Error('共享冲突'), { code: 'EPERM' }); };

test('只有明确共享冲突才使用已安装Shell，不改执行策略；原生结果未知不再次派发', async (unit) => {
  const f = await fixture(unit);
  let calls = 0;
  const execute = async (file, args, options) => {
    calls++;
    assert.equal(file, 'pwsh.exe'); assert.ok(args.includes('-WindowStyle') && args.includes('Hidden'));
    assert.equal(args.some((arg) => /ExecutionPolicy|Bypass|EncodedCommand|^-Command$/u.test(arg)), false);
    assert.equal(options.windowsHide, true); assert.ok(options.timeout <= 8000);
    throw Object.assign(new Error('停止等待'), { killed: true });
  };
  await assert.rejects(movePluginDirectory(f.source, f.target, { platform: 'win32', rename: denied, execute }),
    { code: 'DIRECTORY_COMMIT_UNCONFIRMED' });
  assert.equal(calls, 1); assert.equal((await lstat(f.source)).isDirectory(), true);
  await assert.rejects(movePluginDirectory(f.source, f.target, { platform: 'linux', rename: denied, execute }), { code: 'EPERM' });
  assert.equal(calls, 1);
});

test('原生提交失败保留有界系统错误码，不以诊断触发再次派发', async (unit) => {
  const f = await fixture(unit);
  let calls = 0;
  await assert.rejects(movePluginDirectory(f.source, f.target, {
    platform: 'win32', rename: denied,
    execute: async () => {
      calls++;
      throw Object.assign(new Error('原生调用失败'), {
        stderr: 'DEVICEFORGE_DIRECTORY_FAILED {"hresult":-2147024891}\r\n',
      });
    },
  }), (error) => {
    assert.equal(error.code, 'DIRECTORY_COMMIT_UNCONFIRMED');
    assert.equal(error.nativeHResult, -2147024891);
    assert.match(error.message, /0x80070005/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((await lstat(f.source)).isDirectory(), true);
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});

test('无效或非约定原生诊断不显示任意错误文本、不猜系统错误码', async (unit) => {
  const f = await fixture(unit);
  for (const stderr of ['private-source-path',
    'DEVICEFORGE_DIRECTORY_FAILED {"hresult":"private-source-path"}',
    'DEVICEFORGE_DIRECTORY_FAILED {"hresult":4294967296}',
    'DEVICEFORGE_DIRECTORY_FAILED {"hresult":5.5}',
    'DEVICEFORGE_DIRECTORY_FAILED broken-json']) {
    await assert.rejects(movePluginDirectory(f.source, f.target, {
      platform: 'win32', rename: denied,
      execute: async () => { throw Object.assign(new Error('不复制自由文本'), { stderr }); },
    }), (error) => {
      assert.equal(error.code, 'DIRECTORY_COMMIT_UNCONFIRMED');
      assert.equal(error.nativeHResult, undefined);
      assert.doesNotMatch(error.message, /private-source-path|broken-json|0x/);
      return true;
    });
  }
});

test('Windows现行允许策略下原生提交只移动自有同父目录，内容不变且不覆盖目标',
  { skip: process.platform === 'win32' ? false : '仅Windows存在原生目录提供者' }, async (unit) => {
    const f = await fixture(unit);
    await movePluginDirectory(f.source, f.target, { rename: denied });
    assert.equal(await readFile(join(f.target, 'marker.json'), 'utf8'), '{"owned":true}');
    await assert.rejects(lstat(f.source), { code: 'ENOENT' });
    await mkdir(f.source); await writeFile(join(f.source, 'marker.json'), '新暂存');
    await assert.rejects(movePluginDirectory(f.source, f.target, { rename: denied }), { code: 'DIRECTORY_COMMIT_UNCONFIRMED' });
    assert.equal(await readFile(join(f.target, 'marker.json'), 'utf8'), '{"owned":true}');
    assert.equal(await readFile(join(f.source, 'marker.json'), 'utf8'), '新暂存');
  });
