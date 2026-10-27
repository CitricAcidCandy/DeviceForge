import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTestFiles, runTestPlan, runTests } from '../scripts/run-tests.ts';

test('自动识别直接、别名、动态及传递 Vite 依赖，类型导入不占起服队列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-ui-runner-'));
  try {
    await mkdir(join(root, 'tests'));
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      moduleResolution: 'Bundler', paths: { '@tools/*': ['./scripts/*'] },
    } }));
    const sources = {
      'tests/direct.test.ts': 'import { createServer as serve } from "vite"; void serve;',
      'tests/indirect.test.ts': 'import "@tools/helper.ts";',
      'tests/dynamic.test.ts': 'await import("vite");',
      'tests/ordinary.test.ts': '// createServer from "vite"\nconst text = "vite";',
      'tests/type.test.ts': 'import type { ViteDevServer } from "vite";',
      'scripts/helper.ts': 'export * from "./cycle.ts";',
      'scripts/cycle.ts': 'import "./helper.ts"; export { createServer } from "vite";',
    };
    for (const [name, content] of Object.entries(sources)) await writeFile(join(root, name), content);
    const plan = await planTestFiles(root, ['direct.test.ts', 'indirect.test.ts', 'dynamic.test.ts', 'ordinary.test.ts', 'type.test.ts']);
    assert.deepEqual(plan.serial, ['direct.test.ts', 'indirect.test.ts', 'dynamic.test.ts']);
    assert.deepEqual(plan.parallel, ['ordinary.test.ts', 'type.test.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Vite 独占阶段不与普通任务重叠，其余任务遵守并发上限且不漏测', async () => {
  let active = 0;
  let maximum = 0;
  let vite = false;
  const finished: string[] = [];
  await runTestPlan({ serial: ['vite-a', 'vite-b'], parallel: ['a', 'b', 'c', 'd', 'e'] }, async (name) => {
    if (name.startsWith('vite')) {
      assert.equal(active, 0);
      assert.equal(vite, false);
      vite = true;
    } else {
      assert.equal(vite, false);
      active++;
      maximum = Math.max(maximum, active);
    }
    await new Promise<void>((done) => setTimeout(done, 10));
    if (name.startsWith('vite')) vite = false;
    else active--;
    finished.push(name);
  }, () => false, 2);
  assert.equal(maximum, 2);
  assert.equal(finished.length, 7);
  assert.deepEqual(finished.slice(-2), ['vite-a', 'vite-b']);
});

test('真实测试子进程失败会汇总非零退出码，仍执行其余文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-ui-runner-child-'));
  try {
    await mkdir(join(root, 'tests'));
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, 'tests', `${name}.test.ts`), `
      import { writeFile } from 'node:fs/promises';
      await writeFile('${name}.txt', '已执行');
      process.exitCode = ${name === 'b' ? 1 : 0};
    `);
    assert.equal(await runTests(root), 1);
    for (const name of ['a', 'b', 'c']) assert.equal(await readFile(join(root, `${name}.txt`), 'utf8'), '已执行');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('中断后不再调度后续文件，非法并发上限被拒绝', async () => {
  let stopped = false;
  const finished: string[] = [];
  await runTestPlan({ serial: ['vite'], parallel: ['a', 'b'] }, async (file) => {
    finished.push(file);
    stopped = true;
  }, () => stopped, 1);
  assert.deepEqual(finished, ['a']);
  await assert.rejects(runTestPlan({ serial: [], parallel: [] }, async () => {}, () => false, 0));
});
