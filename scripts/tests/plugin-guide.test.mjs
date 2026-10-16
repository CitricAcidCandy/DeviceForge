import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginModule } from '../../frontend/src/plugins/contracts.ts';
import { createPluginScope } from '../../frontend/src/plugins/scope.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const frontendRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));

function block(markdown, name) {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex(
    (line) =>
      /^#{2,6}\s/.test(line) &&
      line
        .replace(/^#{2,6}\s+/, '')
        .replaceAll('`', '')
        .trim() === name,
  );
  assert.ok(heading >= 0, `指南缺少完整文件标题：${name}`);
  let start = heading + 1;
  while (lines[start]?.trim() === '') start++;
  assert.match(lines[start] ?? '', /^```(?:json|javascript|js|mjs)$/);
  const end = lines.findIndex((line, index) => index > start && line === '```');
  assert.ok(end > start, `${name} 的文件代码块未闭合`);
  return lines.slice(start + 1, end).join('\n') + '\n';
}

async function fixture(target, names, run) {
  const markdown = await readFile(
    join(root, target, 'docs/guides/plugin-development/examples.md'),
    'utf8',
  );
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'deviceforge-guide-example-'));
  try {
    for (const name of names) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), block(markdown, name), 'utf8');
    }
    const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const manifest = JSON.parse(
      await readFile(join(directory, packageJson.deviceforge.manifest), 'utf8'),
    );
    assert.equal(packageJson.version, manifest.version, '包版本与插件清单必须相同');
    await run({ directory, packageJson, manifest });
  } finally {
    const child = relative(temporaryRoot, directory);
    assert.ok(child && !child.startsWith('..' + sep) && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  }
}

async function runEntry(directory, entry, request) {
  const child = spawn(process.execPath, [entry], {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  const errors = [];
  let size = 0;
  const collect = (chunks) => (bytes) => {
    size += bytes.length;
    if (size > 1024 * 1024) child.kill();
    else chunks.push(bytes);
  };
  child.stdout.on('data', collect(output));
  child.stderr.on('data', collect(errors));
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const exited = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    child.stdin.end(JSON.stringify(request) + '\n');
    const exit = await exited;
    assert.equal(exit.signal, null, '示例插件不应挂起或超过输出限额');
    assert.equal(exit.code, 0, Buffer.concat(errors).toString('utf8'));
    assert.ok(size <= 1024 * 1024);
    const lines = Buffer.concat(output).toString('utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1, '协议 stdout 只能输出一个响应帧');
    return JSON.parse(lines[0]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test('前端指南完整文件符合当前真实 SDK，并能执行命令、挂载与释放面板', async () => {
  await fixture(
    'frontend',
    ['package.json', 'plugin.json', 'src/index.js'],
    async ({ directory, packageJson, manifest }) => {
      const entry = packageJson.deviceforge.entrypoints.any;
      assert.equal(packageJson.deviceforge.kind, 'browser');
      assert.equal(entry.runtime, 'browser');
      assert.equal(manifest.api_version, 2);
      const plugin = readPluginModule(
        await import(pathToFileURL(join(directory, entry.path)).href),
      );
      assert.equal(plugin.id, manifest.id);
      assert.equal(plugin.version, manifest.version);
      assert.equal(plugin.apiVersion, manifest.api_version);
      const { JSDOM } = frontendRequire('jsdom');
      const dom = new JSDOM('<main></main>');
      const originals = {
        document: globalThis.document,
        AbortController: globalThis.AbortController,
        AbortSignal: globalThis.AbortSignal,
      };
      Object.assign(globalThis, {
        document: dom.window.document,
        AbortController: dom.window.AbortController,
        AbortSignal: dom.window.AbortSignal,
      });
      let scope;
      try {
        const lifetime = new AbortController();
        const calls = [];
        let unsubscribed = 0;
        const operations = [
          { id: 'plugin.guide_echo.echo', title: '示例回显', input_schema: { type: 'object' } },
        ];
        const host = {
          apiVersion: 2,
          signal: lifetime.signal,
          async listOperations(signal) {
            assert.ok(signal instanceof AbortSignal);
            signal.throwIfAborted();
            calls.push(['list']);
            return { data: operations, logId: 'guide-list-log' };
          },
          async submit(operation, input, signal) {
            signal.throwIfAborted();
            calls.push(['submit', operation, input]);
            return { data: { id: 'guide-job', status: 'queued' }, logId: 'guide-submit-log' };
          },
          async getJob(id, signal) {
            signal.throwIfAborted();
            calls.push(['get', id]);
            return { data: { id, status: 'succeeded' }, logId: 'guide-get-log' };
          },
          async cancelJob(id, signal) {
            signal.throwIfAborted();
            calls.push(['cancel', id]);
            return { data: { id, status: 'cancelled' }, logId: 'guide-cancel-log' };
          },
          subscribeOperations(listener) {
            listener(operations);
            return () => {
              unsubscribed++;
            };
          },
          onDispose() {
            throw new Error('示例应登记到真实插件作用域');
          },
        };
        scope = createPluginScope(host);
        const caller = new AbortController();
        const command = plugin.contributions.commands[0];
        assert.equal(command.id, `${manifest.id}.catalog`);
        assert.deepEqual(await command.execute({}, scope.context, caller.signal), {
          data: [{ id: operations[0].id, title: operations[0].title }],
          logId: 'guide-list-log',
        });
        caller.abort();
        await assert.rejects(command.execute({}, scope.context, caller.signal));
        calls.length = 0;
        const target = dom.window.document.querySelector('main');
        const release = await plugin.panels[0].mount(target, scope.context);
        assert.equal(typeof release, 'function');
        assert.deepEqual(calls, [], '挂载不能自动执行后端任务');
        const click = async (name) => {
          const button = [...target.querySelectorAll('button')].find(
            (node) => node.textContent === name,
          );
          assert.ok(button, `示例缺少按钮：${name}`);
          button.click();
          await new Promise((done) => setImmediate(done));
        };
        await click('刷新操作');
        const select = target.querySelector('select');
        select.value = operations[0].id;
        select.dispatchEvent(new dom.window.Event('change'));
        target.querySelector('textarea').value = '{"message":"中文样例"}';
        await click('提交任务');
        await click('查询任务');
        await click('取消服务器任务');
        assert.deepEqual(calls, [
          ['list'],
          ['submit', operations[0].id, { message: '中文样例' }],
          ['get', 'guide-job'],
          ['cancel', 'guide-job'],
        ]);
        assert.match(target.textContent, /guide-cancel-log/);
        await release();
        assert.equal(target.childElementCount, 0, '面板释放应清空自有 DOM');
        await scope.dispose();
        assert.equal(unsubscribed, 1, '订阅只能释放一次');
      } finally {
        await scope?.dispose();
        Object.assign(globalThis, originals);
        dom.window.close();
      }
    },
  );
});

test('后端指南完整文件可独立执行真实协议，输入校验与清单边界一致', async () => {
  await fixture(
    'backend',
    ['package.json', 'plugin.json', 'entry.mjs'],
    async ({ directory, packageJson, manifest }) => {
      assert.equal(packageJson.deviceforge.kind, 'server');
      const entry = packageJson.deviceforge.entrypoints.any;
      assert.equal(entry.runtime, 'node');
      assert.equal(manifest.protocol_version, 1);
      assert.equal(manifest.operations.length, 1);
      const operation = manifest.operations[0];
      const maximum = operation.input_schema.properties.message.maxLength;
      assert.equal(operation.input_schema.additionalProperties, false);
      assert.deepEqual(operation.input_schema.required, ['message']);
      const request = (input, name = operation.name) => ({
        protocol_version: manifest.protocol_version,
        request_id: 'guide-protocol-check',
        operation: name,
        input,
      });
      const message = '🙂'.repeat(maximum);
      const response = await runEntry(directory, entry.path, request({ message }));
      assert.deepEqual(response, {
        protocol_version: manifest.protocol_version,
        request_id: 'guide-protocol-check',
        result: { message, source: manifest.id },
      });
      for (const input of [
        { message: '中文', unexpected: true },
        { message: '🙂'.repeat(maximum + 1) },
        {},
        null,
      ]) {
        const failure = await runEntry(directory, entry.path, request(input));
        assert.equal(failure.protocol_version, manifest.protocol_version);
        assert.equal(failure.request_id, 'guide-protocol-check');
        assert.equal(typeof failure.error, 'string');
        assert.equal(failure.result, undefined);
      }
      const unknown = await runEntry(
        directory,
        entry.path,
        request({ message: '中文' }, 'unknown'),
      );
      assert.equal(typeof unknown.error, 'string');
      assert.equal(unknown.result, undefined);
    },
  );
});
