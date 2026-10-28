import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginModule } from '../../frontend/src/plugins/contracts.ts';
import { createPluginScope } from '../../frontend/src/plugins/scope.ts';
import { createPluginManager } from '../../frontend/src/plugins/manager.ts';
import { archiveMembers, writeTgz, writeZip } from '../plugin-releases/archive.mjs';
import { validateRelease } from '../plugin-releases/contract.mjs';
import { normalizeManifest } from '../../cli/src/plugin-authoring/manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const frontendRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));
const topics = ['overview', 'manifest', 'sdk', 'lifecycle', 'examples', 'packaging', 'dependencies', 'validation'];

test('MCP 单清单与市场结构直接可用，两端示例符合真实生成器', async () => {
  const marketFields = ['summary', 'keywords', 'categories', 'applies_to', 'supports_mcp', 'supports_agent',
    'restart_policy', 'author', 'license', 'homepage', 'visibility', 'details'];
  for (const target of ['frontend', 'backend']) {
    const directory = join(root, target, 'docs/guides/plugin-development');
    const [manifest, packaging, overview] = await Promise.all(['manifest', 'packaging', 'overview'].map((topic) =>
      readFile(join(directory, `${topic}.md`), 'utf8')));
    const values = [...manifest.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(([, body]) => JSON.parse(body));
    const declaration = values.find((value) => value.manifest_version === 1);
    assert.ok(declaration, `${target} 缺少完整单一清单示例`);
    assert.doesNotThrow(() => normalizeManifest(declaration));
    for (const key of marketFields) {
      assert.ok(manifest.includes(key), `${target} 没有直接给出 market.${key}`);
      assert.ok(Object.hasOwn(declaration.market, key), `${target} 示例缺少 market.${key}`);
    }
    for (const command of ['plugin pack', 'plugin plan', 'plugin publish'])
      assert.ok(packaging.includes(command), `${target} 缺少 ${command}`);
    assert.ok(overview.includes('manifest.json') && overview.includes('market'));
    assert.ok(manifest.includes('resource_id') && manifest.includes('SHA-256'));
  }
});

test('MCP 默认总览、SDK 与示例准确指引现有界面插槽和插件路由', async () => {
  const directory = join(root, 'frontend/docs/guides/plugin-development');
  const [overview, sdk, examples, manifest] = await Promise.all(
    ['overview', 'sdk', 'examples', 'manifest'].map((topic) => readFile(join(directory, `${topic}.md`), 'utf8')),
  );
  for (const slot of ['devices.apps', 'settings.plugin.section', 'route.settings', 'route.marketplace']) {
    assert.ok(overview.includes(slot), `默认总览遗漏可用插槽 ${slot}`);
    assert.ok(sdk.includes(slot), `SDK 遗漏可用插槽 ${slot}`);
  }
  assert.doesNotMatch(overview, /当前产品装配的具名插槽为 `workshop\.extensions`|不自动创建左侧导航或路由/);
  assert.match(overview, /modules[\s\S]*侧栏/);
  for (const term of ['panels', 'components', 'devices.apps', 'append', 'replace', 'mount', '每行'])
    assert.ok(examples.includes(term), `示例遗漏界面接入边界 ${term}`);
  assert.ok(manifest.includes('同一插件'), '清单必须明确路由按插件命名空间判重');
  assert.ok(manifest.includes('/a/b') && manifest.includes('/a-b'), '清单必须说明归一化页面键碰撞');
});

test('MCP 插件开发知识允许无宿主源码独立开发', async () => {
  for (const target of ['frontend', 'backend']) {
    const overview = await readFile(join(root, target, 'docs/guides/plugin-development/overview.md'), 'utf8');
    assert.ok(overview.includes('无需获取宿主源码'), `${target} 总览必须说明公开开发边界`);
    assert.ok(overview.includes('独立工程'), `${target} 总览必须支持独立工程`);
    for (const term of ['开发流程', '公开能力', '接口', '约束', '生命周期', '调试', '发布要求']) {
      assert.ok(overview.includes(term), `${target} 总览缺少公开知识范围 ${term}`);
    }
    for (const topic of topics) {
      const content = await readFile(join(root, target, 'docs/guides/plugin-development', `${topic}.md`), 'utf8');
      assert.doesNotMatch(content, /backend\/(?:(?:crates|examples|scripts|target)\/|Cargo\.toml)|path\s*=\s*"[^"\r\n]*(?:\.\.\/)+(?:crates|backend)\//,
        `${target}/${topic} 不得要求宿主工程路径`);
      assert.doesNotMatch(content, /(?:AGENTS|主代理|scripts\/generate-public-ui|src\/app\/public-ui|examples\/server-service|plugin-sdk\/ui\.ts)/,
        `${target}/${topic} 不得混入宿主维护流程`);
      assert.doesNotMatch(content, /\]\((?!https?:\/\/|#)[^)]+\)/,
        `${target}/${topic} 不得把知识留给本地相对文档`);
      assert.doesNotMatch(content, /(?:详见|见)\s+\.\.\//,
        `${target}/${topic} 不得要求读取仓库相对文档`);
    }
  }
  for (const source of ['plugin_guide.rs', 'plugin_guide/schema.rs']) {
    const content = await readFile(join(root, 'backend/crates/server/src', source), 'utf8');
    assert.ok(content.includes('无需获取宿主源码'), `${source} 必须说明无需源码的开发入口`);
  }
});

test('MCP 维护说明与实际指南版本、支持格式和主题保持同步', async () => {
  const [query, maintenance] = await Promise.all([
    readFile(join(root, 'backend/crates/server/src/plugin_guide/query.rs'), 'utf8'),
    readFile(join(root, 'backend/docs/implementation/MCP插件开发指南.md'), 'utf8'),
  ]);
  const version = query.match(/"guide_version":\s*(\d+)/);
  assert.ok(version, '指南响应必须声明知识版本');
  assert.ok(maintenance.includes(`guide_version=${version[1]}`), '维护说明中的知识版本已过期');
  for (const field of ['release_format_versions', 'release_host_api_versions']) {
    const supported = query.match(new RegExp(`"${field}":\\s*(\\[[\\d,\\s]+\\])`));
    assert.ok(supported, `指南响应缺少 ${field}`);
    const expected = `${field}:${JSON.stringify(JSON.parse(supported[1]))}`;
    assert.ok(maintenance.includes(expected), `维护说明缺少当前声明 ${expected}`);
  }
  for (const topic of topics) {
    assert.ok(maintenance.includes(`\`${topic}\``), `维护说明缺少主题 ${topic}`);
  }
  for (const term of ['dependencies.json', 'deviceforge.get_plugin_dependencies', 'dependency.scan', 'dependency.install']) {
    assert.ok(maintenance.includes(term), `维护说明缺少共享依赖入口 ${term}`);
  }
});

test('八主题十六篇嵌入文档保持固定来源、读取预算与第三版知识覆盖', async () => {
  const catalog = await readFile(
    join(root, 'backend/crates/server/src/plugin_guide/catalog.rs'),
    'utf8',
  );
  const documents = [...catalog.matchAll(/document!\(\s*(Frontend|Backend),\s*(\w+),\s*"([^"]+)"\s*\)/g)];
  assert.equal(documents.length, 16);
  const sources = new Set(documents.map(([, , , source]) => source));
  assert.equal(sources.size, 16, '嵌入来源不得重复');
  const requiredTerms = {
    overview: ['release.json', 'DEVICEFORGE_USER_DIR', 'npx'],
    manifest: ['format_version', 'host_api_version', 'bindings', 'any_of'],
    sdk: ['DEVICEFORGE_PLUGIN_RESOURCES', 'managed_resources', '原值'],
    lifecycle: ['expected_revision', 'configuration_required', '旧'],
    examples: ['release.json', 'blobs/', '结构模板'],
    packaging: ['/api/v1/capabilities', '/api/v1/catalog', 'catalog_last', 'immutable_versions', '离线'],
    validation: ['SHA-256', '配置', 'expected_revision'],
    dependencies: ['dependencies.json', '一次', '.deviceforge', 'expected_revision', 'target_kind'],
  };
  for (const target of ['frontend', 'backend']) {
    for (const topic of topics) {
      const source = `${target}/docs/guides/plugin-development/${topic}.md`;
      const entries = documents.filter(([, side, name, path]) =>
        side.toLowerCase() === target && name.toLowerCase() === topic && path === source,
      );
      assert.equal(entries.length, 1, `${target}/${topic} 必须恰有一个固定来源`);
      const bytes = await readFile(join(root, source));
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert.ok(bytes.length >= 100 && bytes.length <= 128 * 1024, `${source} 超出文档预算`);
      for (const term of requiredTerms[topic]) {
        assert.ok(content.includes(term), `${source} 缺少 ${term}`);
      }
    }
  }
});

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

test('MCP 正文自包含服务 API、功能级生命周期与协议六兼容规则', async () => {
  const required = {
    'frontend/validation': ['调试流程', 'listOperations', 'getJob', 'logId', 'AbortSignal'],
    'backend/validation': ['调试流程', 'tools/list', 'deviceforge.get_job', 'deviceforge.job_events', 'stderr'],
    'frontend/sdk': ['services?: ServiceAccess', 'interface ServiceRef', 'interface TypedService',
      'interface ServiceFeatureDiagnostic', 'interface ServerServiceAccess', 'callTyped', 'whenAvailable',
      'diagnostics()', 'inputSchema', 'outputSchema', 'provider_not_active'],
    'frontend/lifecycle': ['30 秒', '10 秒', '5 秒', 'whenAvailable', 'waiting', 'starting',
      'active', 'failed', 'stopped', 'cleanupErrors', 'feature', '同步死循环'],
    'frontend/examples': ['service-consumer.mjs', 'whenAvailable', 'callTyped', 'guide_service_consumer.status'],
    'backend/manifest': ['services', 'protocol_version=6', 'services: None'],
    'backend/sdk': ['serve_once_with_services', 'ServiceRef', 'ServiceClient'],
    'backend/lifecycle': ['协议 6', '协议 5', '深度上限 8', '4 个活动后代'],
  };
  for (const [document, terms] of Object.entries(required)) {
    const [target, topic] = document.split('/');
    const content = await readFile(join(root, target, 'docs/guides/plugin-development', `${topic}.md`), 'utf8');
    for (const term of terms) assert.ok(content.includes(term), `${document} 的 MCP 正文缺少 ${term}`);
  }
  const smoke = await readFile(join(root, 'backend/scripts/plugin-guide-smoke.mjs'), 'utf8');
  for (const term of ["'dependencies'", 'data.guide_version, 4', 'data.release_format_versions, [1, 2]',
    'whenAvailable', 'callTyped', '30 秒']) {
    assert.ok(smoke.includes(term), `真实 MCP 验收缺少当前知识覆盖 ${term}`);
  }
});

test('MCP 服务组合示例能等待、类型化调用、局部撤销并在提供者换代后恢复', { timeout: 10000 }, async () => {
  await fixture('frontend', ['package.json', 'plugin.json', 'src/index.js', 'service-consumer.mjs'], async ({ directory }) => {
    const consumer = (await import(pathToFileURL(join(directory, 'service-consumer.mjs')).href)).default;
    const unsupported = async () => { throw new Error('此示例不应提交服务器任务'); };
    const host = { apiVersion: 2, signal: new AbortController().signal,
      listOperations: async () => ({ data: [], logId: null }), submit: unsupported,
      getJob: unsupported, cancelJob: unsupported, subscribeOperations: () => () => {}, onDispose: () => () => {} };
    const runtime = createPluginManager({ host, panelTarget: () => null });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done)); };
    const available = () => runtime.extensions.catalog().commands.map((command) => command.id);
    runtime.register({ id: consumer.id, trusted: true, plugin: consumer });
    runtime.register({ id: 'guide_service_provider', trusted: true, plugin: {
      id: 'guide_service_provider', version: '1.0.0', apiVersion: 2, panels: [], contributions: { services: [{
        id: 'guide_service_provider.echo', version: '1', inputSchema: { type: 'string' }, outputSchema: { type: 'string' },
        invoke: async (input) => ({ data: input, logId: 'guide-service-log' }),
      }] },
    } });
    try {
      await runtime.load(consumer.id); await flush();
      assert.deepEqual(available(), ['guide_service_consumer.status']);
      await runtime.load('guide_service_provider'); await flush();
      assert.ok(available().includes('guide_service_consumer.echo'));
      const signal = new AbortController().signal;
      assert.deepEqual(await runtime.extensions.executeCommand('guide_service_consumer.echo', '中文组合', signal),
        { data: '中文组合', logId: 'guide-service-log' });
      await assert.rejects(runtime.extensions.executeCommand('guide_service_consumer.echo', 42, signal), /输入/);
      await runtime.unload('guide_service_provider'); await flush();
      assert.deepEqual(available(), ['guide_service_consumer.status']);
      assert.equal(runtime.snapshot().find((entry) => entry.id === consumer.id)?.state, 'loaded');
      await runtime.load('guide_service_provider'); await flush();
      assert.equal((await runtime.extensions.executeCommand('guide_service_consumer.echo', '新代', signal)).data, '新代');
    } finally {
      await runtime.dispose();
    }
  });
});

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

test('成套结构模板与两端组件身份一致，替换真实归档后形成完整离线闭包', async () => {
  const serverNames = ['package.json', 'plugin.json', 'entry.mjs'];
  const browserNames = ['package.json', 'plugin.json', 'src/index.js'];
  await fixture('backend', serverNames, async (server) => {
    await fixture('frontend', browserNames, async (browser) => {
      const examples = async (target) => {
        const markdown = await readFile(
          join(root, target, 'docs/guides/plugin-development/examples.md'),
          'utf8',
        );
        return [...markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(
          ([, content]) => JSON.parse(content),
        );
      };
      const releaseTemplates = (await examples('backend')).filter(
        (value) => value.format_version === 1 && Array.isArray(value.components),
      );
      const componentTemplates = (await examples('frontend')).filter(Array.isArray);
      assert.equal(releaseTemplates.length, 1);
      assert.equal(componentTemplates.length, 1);
      const release = releaseTemplates[0];
      assert.equal(release.host_api_version, 2);
      assert.equal(release.components.length, 2);
      assert.deepEqual(release.components, componentTemplates[0], '两端成套模板必须一致');
      assert.throws(() => validateRelease(release), '未替换的结构模板不得成为可安装成品');

      const members = [];
      for (const component of release.components) {
        const { directory, packageJson, manifest } = component.kind === 'server' ? server : browser;
        const names = component.kind === 'server' ? serverNames : browserNames;
        assert.equal(component.id, manifest.id);
        assert.equal(component.version, manifest.version);
        assert.equal(component.kind, packageJson.deviceforge.kind);
        const files = new Map();
        for (const name of names) {
          files.set(`package/${name}`, await readFile(join(directory, name)));
        }
        const archive = join(directory, `${component.id}.tgz`);
        await writeTgz(archive, files);
        assert.deepEqual(await archiveMembers(archive, 'tgz'), files);
        const bytes = await readFile(archive);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        assert.equal(component.variants.length, 1);
        const variant = component.variants[0];
        assert.equal(variant.platform, 'any');
        assert.equal(variant.format, 'tgz');
        Object.assign(variant, { path: `blobs/${sha256}`, sha256, size: bytes.length });
        members.push({ name: variant.path, bytes });
      }
      validateRelease(release);
      const manifestBytes = Buffer.from(JSON.stringify(release));
      members.unshift({ name: 'release.json', bytes: manifestBytes });
      const offline = join(server.directory, 'guide-suite.zip');
      await writeZip(offline, members);
      const closed = await archiveMembers(offline, 'zip');
      assert.equal(closed.size, 3, '离线根只含发布清单和两个实际组件归档');
      assert.deepEqual(closed.get('release.json'), manifestBytes);
      for (const component of release.components) {
        const variant = component.variants[0];
        const bytes = closed.get(variant.path);
        assert.ok(bytes, '离线闭包不得缺少清单引用的资源');
        assert.equal(bytes.length, variant.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), variant.sha256);
      }

      // 此处只验证在线清单转换与修订，不发起资源发布或宿主安装。
      const online = structuredClone(release);
      for (const component of online.components) {
        for (const variant of component.variants) variant.path = variant.sha256;
      }
      validateRelease(online);
      const revision = (bytes) => createHash('sha256').update(bytes).digest('hex');
      assert.notEqual(revision(Buffer.from(JSON.stringify(online))), revision(manifestBytes));
    });
  });
});
