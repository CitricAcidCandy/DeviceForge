import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { developmentWatch } from '../scripts/development-watch.ts';

test('开发监听只排除所属产物根，不误排相似目录或插件源码中的同名目录', () => {
  const root = resolve(tmpdir(), 'deviceforge-watch-path-fixture');
  const ignored = developmentWatch(root).ignored;
  assert.ok(typeof ignored === 'function');
  assert.equal(ignored(join(root, 'artifacts')), true);
  assert.equal(ignored(join(root, 'artifacts', 'batch', 'releases', '.deviceforge-pack-AbC123')), true);
  assert.equal(ignored('artifacts/batch/release.json'), true);
  for (const path of [join(root, 'artifacts-other', 'source.ts'), join(root, 'src', 'artifacts', 'index.ts'),
    join(root, 'plugins', 'example', 'src', 'index.ts'), join(root, '..', 'artifacts', 'index.ts')])
    assert.equal(ignored(path), false, '普通源码和其他目录的监听范围保持');
});

test('Windows默认递归监听可复现非空目录提交被拒，关闭本单元自有watcher后原目录可提交',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'deviceforge-watch-lock-'));
    const staging = join(root, 'artifacts', '.deviceforge-pack-AbC123');
    const child = join(staging, 'components'), target = join(root, 'artifacts', 'complete');
    await mkdir(child, { recursive: true });
    await writeFile(join(child, 'plugin.tgz'), '同一份准备字节');
    const server = await createServer({ root, configFile: false, logLevel: 'silent',
      server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (Object.keys(server.watcher.getWatched()).some((path) => resolve(path) === child)) break;
        await new Promise<void>((accept) => { setTimeout(accept, 20); });
      }
      assert.ok(Object.keys(server.watcher.getWatched()).some((path) => resolve(path) === child));
      await assert.rejects(rename(staging, target), (reason: unknown) => reason !== null && typeof reason === 'object' &&
        'code' in reason && reason.code === 'EPERM', '默认监听须复现本次Windows目录提交拒绝');
      await server.close();
      await rename(staging, target);
      assert.equal(await readFile(join(target, 'components/plugin.tgz'), 'utf8'), '同一份准备字节');
    } finally {
      await server.close();
      const absolute = resolve(root);
      if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('deviceforge-watch-lock-'))
        throw new Error('临时对照目录范围不明，保留现场');
      await rm(absolute, { recursive: true, force: true });
    }
  });

test('开发监听排除本前端发行目录，仍观察源码；已封口非空目录可提交而不关闭开发服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-development-watch-'));
  const artifacts = join(root, 'artifacts'), source = join(root, 'src');
  const staging = join(artifacts, '.deviceforge-pack-AbC123');
  const target = join(artifacts, 'independent-plugin');
  await mkdir(join(staging, 'components'), { recursive: true });
  await mkdir(source);
  await writeFile(join(staging, 'release.json'), '{"id":"fixture"}\n');
  await writeFile(join(staging, 'components/plugin.tgz'), '固定构建字节');
  await writeFile(join(source, 'index.ts'), 'export const value = 1;\n');
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', cacheDir: join(root, '.cache'),
    server: { middlewareMode: true, hmr: false, watch: developmentWatch(root) },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (Object.keys(server.watcher.getWatched()).some((path) => resolve(path) === source)) break;
      await new Promise<void>((accept) => { setTimeout(accept, 20); });
    }
    const watched = server.watcher.getWatched();
    const within = (path: string, directory: string) => {
      const child = relative(directory, resolve(path));
      return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    };
    assert.equal(Object.keys(watched).some((path) => within(path, artifacts)), false,
      '发行目录不能被开发服务递归监听并持有目录句柄');
    assert.ok(Object.keys(watched).some((path) => within(path, source)), '源码热更新监听仍保留');
    await rename(staging, target);
    assert.equal(await readFile(join(target, 'components/plugin.tgz'), 'utf8'), '固定构建字节');
    const changed = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('产物提交后源码监听未收到变更')), 3000);
      const listener = (file: string) => {
        if (resolve(file) !== join(source, 'index.ts')) return;
        clearTimeout(timer); server.watcher.off('change', listener); accept();
      };
      server.watcher.on('change', listener);
    });
    await writeFile(join(source, 'index.ts'), 'export const value = 2;\n');
    await changed;
  } finally {
    await server.close();
    const absolute = resolve(root), boundary = resolve(tmpdir()) + sep;
    if (!absolute.startsWith(boundary) || !absolute.includes('deviceforge-development-watch-'))
      throw new Error('临时开发监听目录范围不明，保留现场');
    await rm(absolute, { recursive: true, force: true });
  }
});
