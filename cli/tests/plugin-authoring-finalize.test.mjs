import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ReadStream, WriteStream } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { archiveMembers } from '../../scripts/plugin-releases/archive.mjs';
import { writeTgz, writeZip } from '../../scripts/plugin-releases/archive-write.mjs';
import { measureFile, verifyFile } from '../../scripts/plugin-releases/io.mjs';
import { finalizePluginDirectory } from '../src/plugin-authoring/finalize.mjs';

function failure(code) { return Object.assign(new Error(code), { code }); }

function fixture({ errors = [], elapsed = 0, conflictAt = Infinity, sourceMissingAt = Infinity } = {}) {
  const parent = resolve('finalize-test-output');
  const source = resolve(parent, '.deviceforge-pack-Abc123'), target = resolve(parent, 'plugin');
  const state = { attempts: 0, time: 0, delays: [], probes: 0 };
  const sourceStat = { dev: 1, ino: 7, isDirectory: () => true, isSymbolicLink: () => false };
  const options = {
    now: () => state.time,
    realpath: async (path) => path,
    lstat: async (path) => {
      if (path === source) {
        if (state.attempts >= sourceMissingAt) throw failure('ENOENT');
        return sourceStat;
      }
      assert.equal(path, target);
      state.probes++;
      if (state.attempts >= conflictAt) return sourceStat;
      throw failure('ENOENT');
    },
    rename: async (from, to) => {
      assert.equal(from, source); assert.equal(to, target);
      state.attempts++; state.time += elapsed;
      const code = errors[state.attempts - 1];
      if (code) throw failure(code);
    },
    delay: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      state.delays.push(milliseconds); state.time += milliseconds;
    },
  };
  return { source, target, options, state, sourceStat };
}

test('最后发布只重试暂时EPERM和EBUSY，成功后立即结束', async () => {
  const f = fixture({ errors: ['EPERM', 'EBUSY'] });
  await finalizePluginDirectory(f.source, f.target, f.options);
  assert.equal(f.state.attempts, 3);
  assert.deepEqual(f.state.delays, [100, 200]);
});

test('持续占用有固定次数和总期限，不重复打包或删除目标', async () => {
  const f = fixture({ errors: Array(10).fill('EPERM') });
  await assert.rejects(finalizePluginDirectory(f.source, f.target, f.options), { code: 'EPERM' });
  assert.equal(f.state.attempts, 8);
  assert.deepEqual(f.state.delays, [100, 200, 400, 800, 1600, 3200, 3200]);
  const bounded = fixture({ errors: Array(10).fill('EBUSY'), elapsed: 4900 });
  await assert.rejects(finalizePluginDirectory(bounded.source, bounded.target, bounded.options), { code: 'EBUSY' });
  assert.equal(bounded.state.attempts, 2);
  assert.ok(bounded.state.time <= 10000);
});

test('占用超过旧2秒但在10秒内解除时，仅继续同一目录提交', async () => {
  const f = fixture({ errors: Array(7).fill('EPERM') });
  await finalizePluginDirectory(f.source, f.target, f.options);
  assert.equal(f.state.attempts, 8);
  assert.equal(f.state.time, 9500);
});

test('目标出现、暂存丢失或非可重试错误都立即终止', async () => {
  const conflict = fixture({ errors: ['EPERM'], conflictAt: 1 });
  await assert.rejects(finalizePluginDirectory(conflict.source, conflict.target, conflict.options), { code: 'EEXIST' });
  assert.equal(conflict.state.attempts, 1); assert.deepEqual(conflict.state.delays, []);
  const missing = fixture({ errors: ['EPERM'], sourceMissingAt: 1 });
  await assert.rejects(finalizePluginDirectory(missing.source, missing.target, missing.options), { code: 'ENOENT' });
  assert.equal(missing.state.attempts, 1); assert.deepEqual(missing.state.delays, []);
  const invalid = fixture({ errors: ['EXDEV'] });
  await assert.rejects(finalizePluginDirectory(invalid.source, invalid.target, invalid.options), { code: 'EXDEV' });
  assert.equal(invalid.state.attempts, 1); assert.deepEqual(invalid.state.delays, []);
});

test('取消在调用前或退避中停止，不再派发rename', async () => {
  const controller = new AbortController(), f = fixture({ errors: ['EPERM'] });
  controller.abort(new Error('取消发布'));
  await assert.rejects(finalizePluginDirectory(f.source, f.target, { ...f.options, signal: controller.signal }), /取消发布/u);
  assert.equal(f.state.attempts, 0);
  const active = new AbortController(), waiting = fixture({ errors: ['EBUSY'] });
  await assert.rejects(finalizePluginDirectory(waiting.source, waiting.target, {
    ...waiting.options, signal: active.signal,
    delay: async () => { active.abort(new Error('退避中取消')); },
  }), /退避中取消/u);
  assert.equal(waiting.state.attempts, 1);
});

test('仅同父目录独占暂存可提交，链接或目录换代拒绝重试', async () => {
  const f = fixture();
  await assert.rejects(finalizePluginDirectory(resolve(f.source, 'nested'), f.target, f.options), /暂存|父目录/u);
  await assert.rejects(finalizePluginDirectory(f.source, resolve(f.target, 'nested'), f.options), /父目录/u);
  await assert.rejects(finalizePluginDirectory(f.source, f.target, {
    ...f.options, lstat: async (path) => path === f.source
      ? { ...f.sourceStat, isSymbolicLink: () => true } : f.options.lstat(path),
  }), /暂存/u);
  const changed = fixture({ errors: ['EPERM'] });
  await assert.rejects(finalizePluginDirectory(changed.source, changed.target, {
    ...changed.options, lstat: async (path) => path === changed.source && changed.state.attempts > 0
      ? { ...changed.sourceStat, ino: 8 } : changed.options.lstat(path),
  }), /身份/u);
  assert.equal(changed.state.attempts, 1);
});

test('真实文件系统仅提交同卷暂存目录，保留内容', async (unit) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'deviceforge-finalize-test-')));
  unit.after(async () => {
    const verified = await realpath(parent);
    assert.equal(dirname(verified), await realpath(tmpdir()));
    assert.ok(basename(verified).startsWith('deviceforge-finalize-test-'));
    await rm(verified, { recursive: true, force: true });
  });
  const source = join(parent, '.deviceforge-pack-Abc123'), target = join(parent, 'plugin');
  await mkdir(source);
  await writeFile(join(source, 'pack-report.json'), '{"complete":true}');
  await finalizePluginDirectory(source, target);
  assert.equal(await readFile(join(target, 'pack-report.json'), 'utf8'), '{"complete":true}');
  await assert.rejects(realpath(source), { code: 'ENOENT' });
});

test('原生重命名忽略取消时停止等待，迟到失败被消费且不重放', async () => {
  const controller = new AbortController(), f = fixture();
  let finish;
  const pending = new Promise((resolve, reject) => { finish = reject; });
  await assert.rejects(finalizePluginDirectory(f.source, f.target, {
    ...f.options, signal: controller.signal, rename: async () => {
      f.state.attempts++; controller.abort(new Error('停止等待本次发布')); return pending;
    },
  }), /停止等待本次发布/u);
  finish(failure('EPERM'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.state.attempts, 1); assert.deepEqual(f.state.delays, []);
});

test('归档写入与摘要读取成功返回前已关闭本次文件流', async (unit) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'deviceforge-finalize-test-')));
  unit.after(async () => {
    const verified = await realpath(parent);
    assert.equal(dirname(verified), await realpath(tmpdir()));
    assert.ok(basename(verified).startsWith('deviceforge-finalize-test-'));
    await rm(verified, { recursive: true, force: true });
  });
  const active = new Set(), observed = new Set();
  for (const stream of [ReadStream, WriteStream]) {
    const original = stream.prototype.emit;
    unit.mock.method(stream.prototype, 'emit', function(event, ...values) {
      if (typeof this.path === 'string' && dirname(this.path) === parent) {
        if (event === 'open') { active.add(this); observed.add(this); }
        if (event === 'close') active.delete(this);
      }
      return Reflect.apply(original, this, [event, ...values]);
    });
  }
  const tgz = join(parent, 'component.tgz'), zip = join(parent, 'release.zip');
  await writeTgz(tgz, new Map([['index.js', Buffer.from('export default () => ({apiVersion:2});')]]));
  assert.equal(active.size, 0);
  const descriptor = await measureFile(tgz);
  assert.equal(active.size, 0);
  await verifyFile(tgz, descriptor);
  assert.equal(active.size, 0);
  await writeZip(zip, [{ name: 'component.tgz', path: tgz }]);
  assert.equal(active.size, 0);
  await measureFile(zip);
  assert.equal(active.size, 0);
  assert.ok(observed.size >= 6);
});

function deflatedZip(name, bytes) {
  const filename = Buffer.from(name), compressed = deflateRawSync(bytes), checksum = crc32(bytes);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(0x81a40000, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

for (const format of ['tgz', 'zip']) {
  test(`${format}校验返回前等待文件输入关闭，销毁标记不作为关闭回执`, async (unit) => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'deviceforge-finalize-test-')));
    unit.after(async () => {
      const verified = await realpath(parent);
      assert.equal(dirname(verified), await realpath(tmpdir()));
      assert.ok(basename(verified).startsWith('deviceforge-finalize-test-'));
      await rm(verified, { recursive: true, force: true });
    });
    const source = join(parent, `component.${format}`), bytes = Buffer.from('真实校验正文');
    if (format === 'tgz') await writeTgz(source, new Map([['index.js', bytes]]));
    else await writeFile(source, deflatedZip('index.js', bytes));
    const streams = new Set(), original = ReadStream.prototype._destroy;
    const timers = new Map();
    unit.after(async () => {
      for (const [timer, finish] of timers) { clearTimeout(timer); finish(); }
      await Promise.all([...streams].map((stream) => stream.closed ? Promise.resolve() :
        new Promise((done) => stream.once('close', done))));
    });
    unit.mock.method(ReadStream.prototype, '_destroy', function(error, callback) {
      if (this.path !== source) return Reflect.apply(original, this, [error, callback]);
      streams.add(this);
      // 模拟真实文件关闭回执晚于解压流结束，确保读取函数不能提早交回控制权。
      const finish = () => { timers.delete(timer); Reflect.apply(original, this, [error, callback]); };
      const timer = setTimeout(finish, 30);
      timers.set(timer, finish);
    });
    const members = await archiveMembers(source, format);
    assert.deepEqual(members.get('index.js'), bytes);
    assert.ok(streams.size > 0);
    assert.ok([...streams].every((stream) => stream.closed), '仍有只destroy但未close的文件输入');
  });
}
