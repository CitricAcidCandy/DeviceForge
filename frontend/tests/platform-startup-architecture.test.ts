import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { checkArchitecture } from '../scripts/check-architecture.ts';

test('正常架构入口执行启动静态边界，不接受旧业务或缺失入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-startup-architecture-'));
  const put = async (file: string, content: string) => {
    const target = join(root, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  };
  try {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: {
      module: 'esnext', moduleResolution: 'bundler',
    } }));
    await put('src/app/main.ts', 'export const platform = true;');
    await checkArchitecture(root);
    await put('src/app/product/legacy-services.ts', 'export const legacy = true;');
    await put('src/app/main.ts', 'export * from "./product/legacy-services.ts";');
    await assert.rejects(checkArchitecture(root), /启动静态图进入旧业务实现或显式兼容入口/);
    await put('src/app/main.ts', 'export * from "./missing-platform.ts";');
    await assert.rejects(checkArchitecture(root), /本地运行时静态依赖无法解析/);
  } finally {
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep));
    await rm(path, { recursive: true, force: true });
  }
});
