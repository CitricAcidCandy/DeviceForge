import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ConfigurationDefinition,
  HostContext,
  JsonValue,
  WebPlugin,
} from '../src/plugin-sdk/index.ts';
import type {
  BrowserConfigurationPersistence,
  BrowserConfigurationRecord,
} from '../src/features/plugin-configurations/index.ts';

type ObjectValue = Record<string, unknown>;
type ConfigurationModule = typeof import('../src/features/plugin-configurations/index.ts');
type ApiModule = typeof import('../src/services/api/index.ts');
type ManagerModule = typeof import('../src/plugins/index.ts');
interface Protocol {
  call(method: string, params?: ObjectValue, timeout?: number): Promise<unknown>;
  close(): void;
}
interface ProtocolModule {
  themeProtocol(url: string, evidence: ObjectValue): Promise<Protocol>;
}
interface Observer {
  wait(milliseconds: number): Promise<unknown>;
  force(): Promise<unknown>;
}
interface LifecycleModule {
  observeChild(child: ChildProcess, evidence: ObjectValue): Observer;
  normalExit(evidence: ObjectValue): boolean;
}
interface BrowserInput {
  apiUrl: string;
  runId: string;
  phase: 'setup' | 'verify';
  expected: ObjectValue;
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): ObjectValue {
  assert.ok(object(value), '证据不是有效对象');
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === 'string' && value.length > 0, '缺少必要文本');
  return value;
}
function protocolModule(value: unknown): value is ProtocolModule {
  return object(value) && typeof value['themeProtocol'] === 'function';
}
function lifecycleModule(value: unknown): value is LifecycleModule {
  return (
    object(value) &&
    typeof value['observeChild'] === 'function' &&
    typeof value['normalExit'] === 'function'
  );
}

// 此函数经 Node 去除类型后在真实浏览器执行，所有运行依赖均在函数内部导入。
async function browserPhase(input: BrowserInput) {
  const checks: string[] = [];
  const requests: { method: string; path: string; status: number; log_id: string | null }[] = [];
  let stage = '导入公开模型入口';
  function ok(condition: unknown, name: string): asserts condition {
    stage = name;
    if (!condition) throw new Error(name);
    checks.push(name);
  }
  function isObject(value: unknown): value is ObjectValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function configurationModule(value: unknown): value is ConfigurationModule {
    return (
      isObject(value) &&
      typeof value['createBrowserConfigurations'] === 'function' &&
      typeof value['createBrowserConfigurationPersistence'] === 'function'
    );
  }
  function apiModule(value: unknown): value is ApiModule {
    return isObject(value) && typeof value['createApiClient'] === 'function';
  }
  function managerModule(value: unknown): value is ManagerModule {
    return isObject(value) && typeof value['createPluginManager'] === 'function';
  }
  const featurePath = '/src/features/plugin-configurations/index.ts';
  const apiPath = '/src/services/api/index.ts';
  const managerPath = '/src/plugins/index.ts';
  const feature: unknown = await import(featurePath);
  const api: unknown = await import(apiPath);
  const plugins: unknown = await import(managerPath);
  if (!configurationModule(feature) || !apiModule(api) || !managerModule(plugins))
    throw new Error(stage);
  const configurationFeature = feature;
  const controller = new AbortController();
  const signal = controller.signal;
  const ids = {
    migrated: `browser_user_${input.runId}_migration`,
    saved: `browser_user_${input.runId}_save`,
    defaults: `browser_user_${input.runId}_defaults`,
    sdk: `browser_user_${input.runId}_sdk`,
    failed: `browser_user_${input.runId}_failed`,
  };
  const definition: ConfigurationDefinition = {
    version: 1,
    apply_policy: 'next_invocation',
    defaults: { count: 2, secret: 'fixture-' + input.runId },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'secret'],
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 100 },
        secret: { type: 'string', writeOnly: true },
      },
    },
  };
  const key = (id: string) =>
    `deviceforge.plugin-configuration:${encodeURIComponent(new URL(input.apiUrl).toString().replace(/\/$/, ''))}:${encodeURIComponent(id)}`;
  const count = (value: JsonValue) => (isObject(value) ? value['count'] : undefined);
  const models: ReturnType<ConfigurationModule['createBrowserConfigurations']>[] = [];
  let blockId: string | null = null;
  const readGate = { release() {} };
  let readStarted: (() => void) | undefined;
  let blocked = Promise.resolve();
  let rejectWrites = false;
  let rejectReads: string | null = null;
  const transport: typeof fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    const method = init?.method ?? (request instanceof Request ? request.method : 'GET');
    if (method === 'GET' && url.pathname.endsWith('/' + blockId)) {
      readStarted?.();
      await blocked;
    }
    if (method === 'GET' && url.pathname.endsWith('/' + rejectReads))
      throw new TypeError('受控读取失败');
    if (rejectWrites && method === 'PATCH') throw new TypeError('受控传输失败');
    const response = await fetch(request, init);
    requests.push({
      method,
      path: url.pathname,
      status: response.status,
      log_id: response.headers.get('x-deviceforge-log-id'),
    });
    return response;
  };
  const client = api.createApiClient({ baseUrl: input.apiUrl, transport });
  const persistence = feature.createBrowserConfigurationPersistence(client);
  function model(store: BrowserConfigurationPersistence = persistence) {
    const instance = configurationFeature.createBrowserConfigurations({
      baseUrl: input.apiUrl,
      persistence: store,
      legacyStorage: localStorage,
    });
    models.push(instance);
    return instance;
  }
  function legacy(value: number): BrowserConfigurationRecord {
    return {
      version: 1,
      values: { count: value, secret: 'fixture-' + input.runId },
      revision: crypto.randomUUID(),
      applied: 'defaults',
      sensitivePaths: ['/secret'],
    };
  }
  let manager: ReturnType<ManagerModule['createPluginManager']> | undefined;
  const revisions: ObjectValue = {};
  try {
    if (input.phase === 'verify') {
      for (const [name, id, expectedCount] of [
        ['migrated', ids.migrated, 4],
        ['saved', ids.saved, 9],
        ['defaults', ids.defaults, 2],
      ] satisfies [string, string, number][]) {
        const current = model();
        current.define(id, definition);
        const view = await current.get(id, signal);
        ok(
          view.revision === input.expected[name] && count(view.values) === expectedCount,
          `${name}刷新或重启后配置与修订保留`,
        );
      }
      ok(localStorage.length === 0, '新浏览器上下文没有本地配置副本');
      return { passed: true, checks, requests, revisions: input.expected };
    }
    stage = '迁移旧 localStorage 配置';
    const old = legacy(4);
    localStorage.setItem(key(ids.migrated), JSON.stringify(old));
    const migratedModel = model();
    migratedModel.define(ids.migrated, definition);
    const migrated = await migratedModel.get(ids.migrated, signal);
    const migratedRaw = await persistence.get(ids.migrated, signal);
    ok(
      migrated.revision === old.revision &&
        count(migrated.values) === 4 &&
        migratedRaw !== null &&
        migratedRaw.values['secret'] === old.values['secret'] &&
        migratedRaw.sensitivePaths.includes('/secret'),
      '旧值完整迁移到真实服务器且敏感值保留',
    );
    revisions['migrated'] = migrated.revision;
    localStorage.setItem(key(ids.migrated), JSON.stringify(legacy(88)));
    const remoteFirst = model();
    remoteFirst.define(ids.migrated, definition);
    const remote = await remoteFirst.get(ids.migrated, signal);
    ok(
      remote.revision === migrated.revision && count(remote.values) === 4,
      '服务器已有配置优先于本地旧值',
    );
    localStorage.removeItem(key(ids.migrated));

    stage = '默认首次落盘';
    const defaultsModel = model();
    defaultsModel.define(ids.defaults, definition);
    const defaults = await defaultsModel.get(ids.defaults, signal);
    const rawDefaults = await persistence.get(ids.defaults, signal);
    ok(
      defaults.source === 'managed' &&
        defaults.revision === 'defaults' &&
        count(rawDefaults?.values ?? null) === 2,
      '默认配置首次读取即落入服务器用户目录',
    );
    revisions['defaults'] = defaults.revision;

    stage = '保存后创建新模型读取';
    const saveModel = model();
    saveModel.define(ids.saved, definition);
    const before = await saveModel.get(ids.saved, signal);
    const saved = await saveModel.save(
      ids.saved,
      before.revision,
      { count: 9, secret: 'fixture-' + input.runId },
      signal,
    );
    const refreshed = model();
    refreshed.define(ids.saved, definition);
    const reread = await refreshed.get(ids.saved, signal);
    ok(
      saved.revision !== before.revision &&
        reread.revision === saved.revision &&
        count(reread.values) === 9,
      '保存后新模型读取同一服务器配置与修订',
    );
    revisions['saved'] = saved.revision;

    stage = '插件管理器等待真实配置读取后激活';
    const sdkRecord = legacy(21);
    await persistence.save(ids.sdk, null, sdkRecord, signal);
    const sdkModel = model();
    const unexpected = async (): Promise<never> => {
      throw new Error('受控插件不应调用业务或设备能力');
    };
    const host: HostContext = {
      apiVersion: 2,
      signal,
      listOperations: unexpected,
      submit: unexpected,
      getJob: unexpected,
      cancelJob: unexpected,
      subscribeOperations: () => () => {},
      onDispose: (dispose) => dispose,
    };
    let activated = false;
    let activatedCount: unknown;
    let failedActivated = false;
    manager = plugins.createPluginManager({
      host,
      panelTarget: () => null,
      configuration: (plugin, current) =>
        sdkModel.prepare(plugin.id, plugin.configuration ?? null, current),
      configurationApplied: (plugin, current) => sdkModel.markApplied(plugin.id, current),
    });
    const sdkPlugin: WebPlugin = {
      id: ids.sdk,
      version: '1.0.0',
      apiVersion: 2,
      panels: [],
      configuration: definition,
      async activate(context) {
        activated = true;
        activatedCount = count(context.configuration?.get() ?? null);
      },
    };
    manager.register({ id: ids.sdk, trusted: true, plugin: sdkPlugin });
    const entered = new Promise<void>((done) => {
      readStarted = done;
    });
    blocked = new Promise<void>((done) => {
      readGate.release = done;
    });
    blockId = ids.sdk;
    const loading = manager.load(ids.sdk);
    await Promise.race([
      entered,
      loading.then(() => {
        throw new Error('配置读取前插件已经完成激活');
      }),
    ]);
    ok(
      !activated &&
        manager.snapshot().some((entry) => entry.id === ids.sdk && entry.state === 'loading'),
      '配置读取尚未完成时插件保持 loading 且未激活',
    );
    blockId = null;
    readGate.release();
    await loading;
    ok(
      activated &&
        activatedCount === 21 &&
        manager.snapshot().some((entry) => entry.id === ids.sdk && entry.state === 'loaded'),
      '配置读取完成后 SDK 激活取得真实用户配置',
    );

    stage = '真实保存传输失败不本地假保存';
    rejectWrites = true;
    let saveRejected = false;
    try {
      await saveModel.save(
        ids.saved,
        saved.revision,
        { count: 33, secret: 'fixture-' + input.runId },
        signal,
      );
    } catch {
      saveRejected = true;
    }
    rejectWrites = false;
    const afterFailure = await persistence.get(ids.saved, signal);
    const afterFailureModel = await saveModel.get(ids.saved, signal);
    ok(
      saveRejected &&
        afterFailure !== null &&
        afterFailure.revision === saved.revision &&
        count(afterFailure.values) === 9 &&
        count(afterFailureModel.values) === 9 &&
        localStorage.getItem(key(ids.saved)) === null,
      '保存传输失败明确拒绝且服务器旧值与本地存储保持',
    );

    stage = '首次落盘失败不本地降级';
    rejectWrites = true;
    const failedModel = model();
    failedModel.define(ids.failed, definition);
    let initialRejected = false;
    try {
      await failedModel.get(ids.failed, signal);
    } catch {
      initialRejected = true;
    }
    rejectWrites = false;
    ok(
      initialRejected &&
        (await persistence.get(ids.failed, signal)) === null &&
        localStorage.getItem(key(ids.failed)) === null,
      '默认首次落盘失败明确拒绝且没有本地副本',
    );

    stage = '插件配置读取失败阻止激活';
    manager.register({
      id: ids.failed,
      trusted: true,
      plugin: {
        id: ids.failed,
        version: '1.0.0',
        apiVersion: 2,
        panels: [],
        configuration: definition,
        async activate() {
          failedActivated = true;
        },
      },
    });
    rejectReads = ids.failed;
    let loadRejected = false;
    try {
      await manager.load(ids.failed);
    } catch {
      loadRejected = true;
    }
    rejectReads = null;
    ok(
      loadRejected &&
        !failedActivated &&
        !manager.snapshot().some((entry) => entry.id === ids.failed),
      '配置读取失败时管理器回滚并且不激活插件',
    );
    ok(localStorage.length === 0, '迁移与保存不创建新的本地配置副本');
    return { passed: true, checks, requests, revisions };
  } catch {
    return { passed: false, checks, requests, failure: stage, revisions };
  } finally {
    readGate.release();
    await manager?.dispose();
    controller.abort();
    for (const current of models) current.dispose();
  }
}

function localUrl(value: string): string {
  const url = new URL(value);
  assert.ok(
    url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    '验收地址必须为不含凭证的本机 HTTP 根地址',
  );
  return url.origin;
}

async function portReleased(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((done, fail) => {
      probe.once('error', fail);
      probe.listen(port, '127.0.0.1', done);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) await new Promise<void>((done) => probe.close(() => done()));
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help')) {
    console.log(
      '用法：node frontend/scripts/browser-user-configuration-smoke.ts --api-url <隔离API根地址> --run-id <UUID> [--dev-url http://127.0.0.1:5173] [--phase setup|restart] [--state <首次报告>] [--output <全新目录>] [--browser <浏览器程序>]',
    );
    return;
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = text(arguments_[index]),
      value = text(arguments_[index + 1]);
    assert.ok(
      [
        '--api-url',
        '--dev-url',
        '--run-id',
        '--phase',
        '--state',
        '--output',
        '--browser',
      ].includes(name) && !value.startsWith('--'),
      '验收参数无效',
    );
    assert.ok(options[name] === undefined, '验收参数重复');
    options[name] = value;
  }
  const apiUrl = localUrl(text(options['--api-url']));
  const devUrl = localUrl(options['--dev-url'] ?? 'http://127.0.0.1:5173');
  const runId = text(options['--run-id']);
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const phase = options['--phase'] ?? 'setup';
  assert.ok(phase === 'setup' || phase === 'restart', '验收阶段只能为 setup 或 restart');
  let expected: ObjectValue = {};
  if (phase === 'restart') {
    const previous: unknown = JSON.parse(await readFile(resolve(text(options['--state'])), 'utf8'));
    const state = record(previous);
    assert.ok(
      state['run_id'] === runId && state['passed'] === true,
      '重启验证必须引用同一轮已通过的首次报告',
    );
    expected = record(state['expected_revisions']);
  }
  const project = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const output = options['--output']
    ? resolve(options['--output'])
    : join(project, 'artifacts', `browser-user-configurations-${randomUUID()}`);
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output);
  const profileId = randomUUID();
  const profile = join(output, 'profile-' + profileId);
  const evidence: ObjectValue = { socket_events: [] };
  const report: ObjectValue = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    phase,
    passed: false,
    scope:
      '真实 Vite 模块、浏览器 localStorage、公开配置模型/API 与插件管理器；无产品界面或设备操作',
    browser_process: evidence,
  };
  const lifecycle: unknown = await import(
    pathToFileURL(join(project, 'scripts/unified-discovery-browser/lifecycle.mjs')).href
  );
  const protocol: unknown = await import(
    pathToFileURL(join(project, 'scripts/browser-theme-smoke/cdp.mjs')).href
  );
  assert.ok(lifecycleModule(lifecycle) && protocolModule(protocol), '浏览器驱动运行时边界无效');
  let observer: Observer | undefined;
  let browser: Protocol | undefined;
  let page: Protocol | undefined;
  let debuggingPort: number | undefined;
  let stage = '独立服务可达性';
  async function evaluate(input: BrowserInput): Promise<ObjectValue> {
    assert.ok(page, '浏览器页面未连接');
    const reply = record(
      await page.call(
        'Runtime.evaluate',
        {
          expression: `(${browserPhase.toString()})(${JSON.stringify(input)})`,
          returnByValue: true,
          awaitPromise: true,
        },
        60000,
      ),
    );
    assert.ok(!reply['exceptionDetails'], '浏览器行为驱动执行失败；未记录异常原文以保护配置值');
    return record(record(reply['result'])['value']);
  }
  try {
    const health = await fetch(new URL('/api/v2/health', apiUrl), {
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(health.ok, '明确指定的隔离宿主不可达');
    const documentUrl = new URL('/@vite/client', devUrl).href;
    const vite = await fetch(documentUrl, { signal: AbortSignal.timeout(10000) });
    assert.ok(vite.ok, 'Vite 模块服务不可达');
    await health.body?.cancel();
    await vite.body?.cancel();
    stage = '真实浏览器启动';
    const executable =
      options['--browser'] ??
      process.env['DEVICEFORGE_TEST_BROWSER'] ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    await access(executable);
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--disable-gpu',
        '--in-process-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'about:blank',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    observer = lifecycle.observeChild(child, evidence);
    let endpoint = '';
    const deadline = Date.now() + 15000;
    while (!endpoint && Date.now() < deadline) {
      const diagnostic = evidence['diagnostic'];
      endpoint =
        typeof diagnostic === 'string'
          ? (diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? '')
          : '';
      assert.ok(
        child.exitCode === null && !child.signalCode && !evidence['spawn_error'],
        '验收浏览器提前退出',
      );
      if (!endpoint) await delay(50);
    }
    assert.ok(endpoint, '验收浏览器调试端口未就绪');
    debuggingPort = Number(new URL(endpoint).port);
    browser = await protocol.themeProtocol(endpoint, evidence);
    report['browser_version'] = text(record(await browser.call('Browser.getVersion'))['product']);
    const targetUrl = new URL(`http://127.0.0.1:${debuggingPort}/json/new`);
    // 使用 Vite 纯模块响应建立同源文档，不挂载产品入口或默认业务运行实例。
    targetUrl.search = '?' + encodeURIComponent(documentUrl);
    const targetResponse = await fetch(targetUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(targetResponse.ok, '浏览器同源页面创建失败');
    const target = record(await targetResponse.json());
    page = await protocol.themeProtocol(text(target['webSocketDebuggerUrl']), evidence);
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    const ready = async () => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const result = record(
          await page?.call('Runtime.evaluate', {
            expression: `location.origin===${JSON.stringify(devUrl)}&&document.readyState==='complete'&&typeof globalThis.__deviceforgeUserConfigurationSmoke==='undefined'`,
            returnByValue: true,
          }),
        );
        if (record(result['result'])['value'] === true) return;
        await delay(50);
      }
      throw new Error('浏览器同源文档未就绪');
    };
    await ready();
    stage = phase === 'setup' ? '浏览器迁移保存 SDK 与失败路径' : '宿主重启后的全新浏览器读取';
    const result = await evaluate({
      apiUrl,
      runId,
      phase: phase === 'setup' ? 'setup' : 'verify',
      expected,
    });
    report['behavior'] = result;
    assert.ok(result['passed'] === true, '浏览器行为检查失败');
    expected = record(result['revisions']);
    report['expected_revisions'] = expected;
    if (phase === 'setup') {
      stage = '实际页面刷新后重建模型读取';
      await page.call('Runtime.evaluate', {
        expression: `globalThis.__deviceforgeUserConfigurationSmoke=${JSON.stringify(runId)}`,
      });
      await page.call('Page.reload', { ignoreCache: true });
      await delay(100);
      await ready();
      const refreshed = await evaluate({ apiUrl, runId, phase: 'verify', expected });
      report['page_refresh'] = refreshed;
      assert.ok(refreshed['passed'] === true, '实际页面刷新后配置未保留');
    }
    report['passed'] = true;
  } catch {
    report['failure'] = stage;
    process.exitCode = 1;
  } finally {
    page?.close();
    if (browser) {
      await browser.call('Browser.close', {}, 5000).catch(() => {});
      browser.close();
    }
    if (observer) {
      try {
        await observer.wait(10000);
      } catch {
        await observer.force().catch(() => {
          report['browser_cleanup_failed'] = true;
        });
      }
      report['browser_normal_exit'] = lifecycle.normalExit(evidence);
      if (!report['browser_normal_exit']) {
        report['passed'] = false;
        process.exitCode = 1;
      }
    }
    if (debuggingPort !== undefined) {
      const deadline = Date.now() + 5000;
      let released = false;
      while (!released && Date.now() < deadline) {
        released = await portReleased(debuggingPort);
        if (!released) await delay(100);
      }
      report['debugging_port_released'] = released;
      if (!released) {
        report['passed'] = false;
        process.exitCode = 1;
      }
    }
    const target = resolve(profile),
      within = relative(resolve(output), target);
    assert.ok(
      within === 'profile-' + profileId && !isAbsolute(within) && !within.startsWith('..' + sep),
      '浏览器临时目录越界',
    );
    if (!observer || evidence['close']) {
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        report['profile_removed'] = true;
      } catch {
        report['profile_removed'] = false;
        report['passed'] = false;
        process.exitCode = 1;
      }
    } else {
      report['profile_removed'] = false;
      report['passed'] = false;
      process.exitCode = 1;
    }
    delete evidence['diagnostic'];
    report['finished_at'] = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report['passed'], report: join(output, 'report.json') }));
  }
}

export { browserPhase };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
