import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePublicUi, publicUiEntries } from '../scripts/generate-public-ui.ts';

test('当前入口生成可重复，全部产物只读宿主、不打包 React', async () => {
  const root = resolve(import.meta.dirname, '..');
  assert.deepEqual(await generatePublicUi(root, true), []);
  for (const entry of publicUiEntries) {
    const source = await readFile(join(root, 'public', entry.output), 'utf8');
    assert.ok(source.startsWith('// 自动生成自'));
    assert.equal(/\b(?:import|require)\b/u.test(source), false);
    assert.ok(source.includes('__DEVICEFORGE_HOST_UI__'));
  }
});

test('生成器拒绝过期产物，显式再生成后通过只读检查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-ui-generator-'));
  try {
    await mkdir(join(root, 'src/app'), { recursive: true });
    await mkdir(join(root, 'public'));
    for (const entry of publicUiEntries) await writeFile(join(root, 'src/app', entry.source), 'export const version: number = 1;\n');
    await assert.rejects(generatePublicUi(root, true), /产物过期/u);
    assert.equal((await generatePublicUi(root)).length, 6);
    assert.deepEqual(await generatePublicUi(root, true), []);
    const generated = await readFile(join(root, 'public', 'plugin-host.js'), 'utf8');
    await writeFile(join(root, 'public', 'plugin-host.js'), generated.replaceAll('\n', '\r\n'));
    assert.deepEqual(await generatePublicUi(root, true), []);
    await writeFile(join(root, 'public', 'plugin-host.js'), '错误的手写产物');
    await assert.rejects(generatePublicUi(root, true), /plugin-host\.js/u);
    assert.deepEqual(await generatePublicUi(root), ['plugin-host.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
