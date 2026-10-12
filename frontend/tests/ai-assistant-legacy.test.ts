import assert from 'node:assert/strict';
import test from 'node:test';
import { convertLegacyAiSingleRequest, createAiAssistant } from '../src/features/ai-assistant/index.ts';
import type { AiLegacySingleOptions, AiSingleInput } from '../src/features/ai-assistant/index.ts';
import { convertLegacyAiSingleRequest as directConverter } from '../src/features/ai-assistant/legacy.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';

const projectRoot = String.raw`C:\Projects\项目示例`;
const userPrompt = ' \t请保留原文\r\n第二行🙂 e\u0301\n ';
const request = Object.freeze({ projectRoot, userPrompt });
const projectBindings = Object.freeze({ [projectRoot]: 'Demo_2-open' });
const options: AiLegacySingleOptions = Object.freeze({ projectBindings });

function assertProtocolError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'protocol');
    assert.equal(error.code, code);
    assert.equal(error.logId, null);
    assert.equal(error.status, null);
    assert.equal(error.retryAfter, null);
    return true;
  });
}

test('公开入口导出转换函数与类型，只输出公开项目身份和提示词', () => {
  assert.equal(convertLegacyAiSingleRequest, directConverter);
  const input: AiSingleInput = convertLegacyAiSingleRequest(request, options);
  assert.deepEqual(input, { project_id: 'Demo_2-open', prompt: userPrompt });
  assert.deepEqual(Object.keys(input).sort(), ['project_id', 'prompt']);
});

test('显式绑定逐字匹配，调用者可分别登记目录别名', () => {
  const bindings: Record<string, string> = {
    [projectRoot]: 'primary',
    [projectRoot.toLowerCase()]: 'lowercase',
    [projectRoot.replaceAll('\\', '/')]: 'forward',
    [`${projectRoot}\\`]: 'trailing',
    [` ${projectRoot} `]: 'padded',
    [String.raw`.\项目示例`]: 'relative',
  };
  for (const [directory, projectId] of Object.entries(bindings)) {
    assert.deepEqual(convertLegacyAiSingleRequest({ projectRoot: directory, userPrompt }, { projectBindings: bindings }),
      { project_id: projectId, prompt: userPrompt });
  }
});

test('不裁剪目录、不折叠大小写、不统一分隔符、不解析相对路径', () => {
  const directories = [projectRoot.toLowerCase(), projectRoot.replaceAll('\\', '/'), `${projectRoot}\\`,
    ` ${projectRoot}`, `${projectRoot} `, String.raw`.\项目示例`, String.raw`C:\Projects\其他\..\项目示例`];
  for (const directory of directories) {
    assertProtocolError(() => convertLegacyAiSingleRequest({ projectRoot: directory, userPrompt }, options),
      'unbound_legacy_ai_project');
  }
});

test('提示词保留空白、换行、Unicode组合形式及正文，不作裁剪或归一', () => {
  for (const prompt of [userPrompt, '  原始正文  ', '第一行\r\n第二行\n', 'é', 'e\u0301', '🙂\t中文', '\ufeff保留前缀']) {
    const input = convertLegacyAiSingleRequest({ projectRoot, userPrompt: prompt }, options);
    assert.equal(input.prompt, prompt);
    assert.deepEqual(new TextEncoder().encode(input.prompt), new TextEncoder().encode(prompt));
  }
});

test('公开项目ID允许一至八十位合法字符，保留大小写且不从目录推断', () => {
  for (const projectId of ['a', '_', '-', 'A_2-open', 'X'.repeat(80)]) {
    assert.equal(convertLegacyAiSingleRequest(request, { projectBindings: { [projectRoot]: projectId } }).project_id,
      projectId);
  }
});

test('冻结输入、选项和绑定可转换，重复调用不修改对象或共享结果', () => {
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(projectBindings), true);
  const inputDescriptors = Object.getOwnPropertyDescriptors(request);
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  const bindingDescriptors = Object.getOwnPropertyDescriptors(projectBindings);
  const first = convertLegacyAiSingleRequest(request, options);
  const second = convertLegacyAiSingleRequest(request, options);
  assert.notEqual(first, second);
  assert.notEqual(first, request);
  assert.deepEqual(first, second);
  assert.deepEqual(request, { projectRoot, userPrompt });
  assert.equal(options.projectBindings, projectBindings);
  assert.deepEqual(Object.getOwnPropertyDescriptors(request), inputDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(options), optionDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(projectBindings), bindingDescriptors);
});

test('转换失败也不修改冻结请求、选项或绑定', () => {
  const invalidRequest = Object.freeze({ ...request, timeoutMs: undefined });
  const invalidOptions = Object.freeze({ projectBindings: Object.freeze({ [projectRoot]: '../invalid' }) });
  const requestDescriptors = Object.getOwnPropertyDescriptors(invalidRequest);
  const bindingDescriptors = Object.getOwnPropertyDescriptors(invalidOptions.projectBindings);
  assertProtocolError(() => convertLegacyAiSingleRequest(invalidRequest, options), 'unsupported_legacy_ai_fields');
  assertProtocolError(() => convertLegacyAiSingleRequest(request, invalidOptions), 'invalid_legacy_ai_bindings');
  assert.deepEqual(Object.getOwnPropertyDescriptors(invalidRequest), requestDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(invalidOptions.projectBindings), bindingDescriptors);
  assert.deepEqual(options.projectBindings, projectBindings);
});

test('目录未绑定、空绑定及原型内置键不能冒充显式项目绑定', () => {
  assertProtocolError(() => convertLegacyAiSingleRequest(request, { projectBindings: {} }), 'unbound_legacy_ai_project');
  for (const directory of ['missing', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assertProtocolError(() => convertLegacyAiSingleRequest({ projectRoot: directory, userPrompt }, options),
      'unbound_legacy_ai_project');
  }
});

test('拒绝从自定义原型继承请求字段、绑定或选项', () => {
  const inheritedRequest: unknown = Object.setPrototypeOf({}, request);
  const customRequest: unknown = Object.setPrototypeOf({ ...request }, { inherited: true });
  for (const value of [inheritedRequest, customRequest]) {
    assertProtocolError(() => convertLegacyAiSingleRequest(value, options), 'invalid_legacy_ai_input');
  }
  const inheritedBindings: Record<string, string> = {};
  Object.setPrototypeOf(inheritedBindings, projectBindings);
  assertProtocolError(() => convertLegacyAiSingleRequest(request, { projectBindings: inheritedBindings }),
    'invalid_legacy_ai_bindings');
  const inheritedOptions: unknown = Object.setPrototypeOf({}, options);
  assertProtocolError(() => Reflect.apply(convertLegacyAiSingleRequest, undefined, [request, inheritedOptions]),
    'invalid_legacy_ai_bindings');
});

test('无原型JSON对象和原型同名自有目录键仍按显式绑定转换', () => {
  const plainRequest = { ...request };
  const plainBindings: Record<string, string> = { [projectRoot]: 'null-prototype' };
  const plainOptions: AiLegacySingleOptions = { projectBindings: plainBindings };
  Object.setPrototypeOf(plainRequest, null);
  Object.setPrototypeOf(plainBindings, null);
  Object.setPrototypeOf(plainOptions, null);
  assert.deepEqual(convertLegacyAiSingleRequest(plainRequest, plainOptions),
    { project_id: 'null-prototype', prompt: userPrompt });
  for (const directory of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(convertLegacyAiSingleRequest({ projectRoot: directory, userPrompt },
      { projectBindings: { [directory]: 'explicit' } }), { project_id: 'explicit', prompt: userPrompt });
  }
});

test('请求须为JSON对象，字段缺失、非法类型和空目录均拒绝且不强转', () => {
  const invalidInputs: unknown[] = [null, undefined, true, 0, '旧请求', [], [request], new Date(0), new Map(),
    () => request, {}, { projectRoot }, { userPrompt }, { projectRoot: null, userPrompt },
    { projectRoot: 1, userPrompt }, { projectRoot: false, userPrompt }, { projectRoot: [], userPrompt },
    { projectRoot: {}, userPrompt }, { projectRoot: '', userPrompt }, { projectRoot: ' \t\r\n', userPrompt },
    { projectRoot, userPrompt: null }, { projectRoot, userPrompt: undefined }, { projectRoot, userPrompt: 1 },
    { projectRoot, userPrompt: false }, { projectRoot, userPrompt: [] }, { projectRoot, userPrompt: {} }];
  for (const value of invalidInputs) {
    assertProtocolError(() => convertLegacyAiSingleRequest(value, options), 'invalid_legacy_ai_input');
  }
});

test('请求的未知字段、旧会话身份、凭据和执行配置一律拒绝', () => {
  const extras: Record<string, unknown>[] = [{ extra: true }, { extra: undefined }, { project_id: 'demo' },
    { prompt: userPrompt }, { thread_id: '12345678-1234-1234-1234-123456789abc' }, { sessionId: 'old-session' },
    { apiKey: '测试凭据标记' }, { token: '测试令牌标记' }, { cliPath: String.raw`C:\工具\codex.exe` },
    { executable: String.raw`C:\工具\codex.exe` }, { env: { API_KEY: '测试凭据标记' } }, { provider: 'sdk' }];
  for (const extra of extras) {
    assertProtocolError(() => convertLegacyAiSingleRequest({ ...request, ...extra }, options), 'invalid_legacy_ai_input');
  }
});

test('非JSON符号、循环、访问器及不可枚举请求字段拒绝，不触发取值', () => {
  const cyclic: Record<string, unknown> = { ...request };
  cyclic.self = cyclic;
  let reads = 0;
  const accessor: unknown = Object.defineProperty({ projectRoot }, 'userPrompt', {
    enumerable: true, get() { reads++; return userPrompt; },
  });
  const hidden: unknown = Object.defineProperty({ ...request }, 'hidden', { value: 'hidden' });
  for (const value of [{ ...request, [Symbol('字段')]: true }, cyclic, accessor, hidden,
    { projectRoot, userPrompt: 1n }, { projectRoot, userPrompt: Symbol('提示词') }]) {
    assertProtocolError(() => convertLegacyAiSingleRequest(value, options), 'invalid_legacy_ai_input');
  }
  assert.equal(reads, 0);
});

test('timeoutMs与requestId作为自有字段出现即拒绝，包括null和undefined', () => {
  for (const field of ['timeoutMs', 'requestId']) {
    for (const value of [undefined, null, 0, 1000, '', '旧请求身份', false, {}, []]) {
      const input = { ...request, [field]: value };
      assert.equal(Object.hasOwn(input, field), true);
      assertProtocolError(() => convertLegacyAiSingleRequest(input, options), 'unsupported_legacy_ai_fields');
    }
  }
  assertProtocolError(() => convertLegacyAiSingleRequest({ ...request, timeoutMs: undefined, requestId: undefined }, options),
    'unsupported_legacy_ai_fields');
  assertProtocolError(() => convertLegacyAiSingleRequest({ timeoutMs: undefined }, options), 'unsupported_legacy_ai_fields');
});

test('不等价旧字段即使不可枚举或为访问器也拒绝，不能静默丢弃', () => {
  let reads = 0;
  for (const field of ['timeoutMs', 'requestId']) {
    const hidden: unknown = Object.defineProperty({ ...request }, field, { value: undefined });
    const accessor: unknown = Object.defineProperty({ ...request }, field, {
      enumerable: true, get() { reads++; return undefined; },
    });
    for (const value of [hidden, accessor]) {
      assertProtocolError(() => convertLegacyAiSingleRequest(value, options), 'unsupported_legacy_ai_fields');
    }
  }
  assert.equal(reads, 0);
});

test('选项必须显式提供JSON目录绑定，缺失、非法类型和额外选项拒绝', () => {
  const invalidOptions: unknown[] = [null, undefined, true, 0, '绑定', [], {}, new Date(0),
    { projectBindings: undefined }, { projectBindings: null }, { projectBindings: false },
    { projectBindings: 'demo' }, { projectBindings: [] }, { projectBindings: new Map() },
    { projectBindings, extra: true }, { projectBindings, extra: undefined }, { projectBindings, timeoutMs: 1000 },
    { projectBindings, requestId: 'old-id' }, { projectBindings, apiKey: '测试凭据标记' },
    { projectBindings, token: '测试令牌标记' }, { projectBindings, executable: String.raw`C:\工具\codex.exe` },
    { projectBindings, env: { API_KEY: '测试凭据标记' } }];
  for (const value of invalidOptions) {
    assertProtocolError(() => Reflect.apply(convertLegacyAiSingleRequest, undefined, [request, value]),
      'invalid_legacy_ai_bindings');
  }
  assertProtocolError(() => Reflect.apply(convertLegacyAiSingleRequest, undefined, [request]),
    'invalid_legacy_ai_bindings');
});

test('全部绑定须符合公开项目ID规则，未使用的非法绑定也不能忽略', () => {
  for (const projectId of ['', ' ', '../demo', projectRoot, 'with space', '中文项目', 'a.b', 'a/b', 'a\\b',
    'a'.repeat(81), 'demo\n']) {
    assertProtocolError(() => convertLegacyAiSingleRequest(request, { projectBindings: { [projectRoot]: projectId } }),
      'invalid_legacy_ai_bindings');
    assertProtocolError(() => convertLegacyAiSingleRequest(request,
      { projectBindings: { ...projectBindings, unused: projectId } }), 'invalid_legacy_ai_bindings');
  }
  const invalidBindings: unknown[] = [{ [projectRoot]: undefined }, { [projectRoot]: null },
    { [projectRoot]: 1 }, { [projectRoot]: true }, { [projectRoot]: [] }, { [projectRoot]: {} },
    { ...projectBindings, '': 'unused' }, { ...projectBindings, ' \t\r\n': 'unused' }];
  for (const bindings of invalidBindings) {
    assertProtocolError(() => Reflect.apply(convertLegacyAiSingleRequest, undefined,
      [request, { projectBindings: bindings }]), 'invalid_legacy_ai_bindings');
  }
});

test('绑定和选项拒绝符号、不可枚举属性及访问器，不读取隐藏值', () => {
  let reads = 0;
  const accessorBindings: unknown = Object.defineProperty({}, projectRoot, {
    enumerable: true, get() { reads++; return 'demo'; },
  });
  const accessorOptions: unknown = Object.defineProperty({}, 'projectBindings', {
    enumerable: true, get() { reads++; return projectBindings; },
  });
  const hiddenBindings: unknown = Object.defineProperty({ ...projectBindings }, 'hidden', { value: 'demo' });
  const hiddenOptions: unknown = Object.defineProperty({ projectBindings }, 'hidden', { value: true });
  const invalidOptions: unknown[] = [accessorOptions, hiddenOptions, { projectBindings: accessorBindings },
    { projectBindings: hiddenBindings }, { projectBindings: { ...projectBindings, [Symbol('绑定')]: 'demo' } },
    { projectBindings, [Symbol('选项')]: true }];
  for (const value of invalidOptions) {
    assertProtocolError(() => Reflect.apply(convertLegacyAiSingleRequest, undefined, [request, value]),
      'invalid_legacy_ai_bindings');
  }
  assert.equal(reads, 0);
});

test('空提示词和纯空白沿用单次输入资格，非空原文不被裁剪', () => {
  for (const prompt of ['', ' ', '\t\r\n', '\u3000', '\u00a0', '\ufeff']) {
    assertProtocolError(() => convertLegacyAiSingleRequest({ projectRoot, userPrompt: prompt }, options),
      'invalid_ai_input');
  }
  assert.equal(convertLegacyAiSingleRequest({ projectRoot, userPrompt: ' x ' }, options).prompt, ' x ');
});

test('UTF-8提示词恰好131072字节可用，含ASCII、中文、四字节字符和空白', () => {
  const prompts = ['a'.repeat(131072), `${'界'.repeat(43690)}ab`, '🙂'.repeat(32768), `${' '.repeat(131071)}x`];
  for (const prompt of prompts) {
    assert.equal(new TextEncoder().encode(prompt).length, 131072);
    const input = convertLegacyAiSingleRequest(Object.freeze({ projectRoot, userPrompt: prompt }), options);
    assert.equal(input.prompt, prompt);
    assert.equal(input.project_id, 'Demo_2-open');
  }
});

test('UTF-8超过131072字节即拒绝，不按字符数计数、不裁剪或截断', () => {
  const prompts = ['a'.repeat(131073), '界'.repeat(43691), `${'🙂'.repeat(32768)}a`,
    '🙂'.repeat(32769), `${' '.repeat(131072)}x`];
  for (const prompt of prompts) {
    assert.ok(new TextEncoder().encode(prompt).length > 131072);
    const input = Object.freeze({ projectRoot, userPrompt: prompt });
    assertProtocolError(() => convertLegacyAiSingleRequest(input, options), 'invalid_ai_input');
    assert.equal(input.userPrompt, prompt);
  }
});

test('转换成功及各类失败不发请求、不写控制台、不泄漏目录提示词或凭据', (context) => {
  let logged = 0;
  let fetched = 0;
  const methods: readonly ('log' | 'info' | 'warn' | 'error' | 'debug' | 'trace')[] =
    ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const method of methods) {
    context.mock.method(console, method, () => { logged++; });
  }
  context.mock.method(globalThis, 'fetch', async () => { fetched++; throw new Error('纯转换不应请求服务'); });
  const privateDirectory = String.raw`C:\测试私有目录\目录标记`;
  const privatePrompt = '测试提示词标记，禁止记录正文';
  const credential = '测试凭据标记';
  const executable = String.raw`C:\测试工具目录\程序标记.exe`;
  const privateRequest = { projectRoot: privateDirectory, userPrompt: privatePrompt };
  const privateOptions: AiLegacySingleOptions = { projectBindings: { [privateDirectory]: 'demo' } };
  assert.deepEqual(convertLegacyAiSingleRequest(privateRequest, privateOptions),
    { project_id: 'demo', prompt: privatePrompt });
  const cases: { action: () => unknown; code: string; message: string }[] = [
    { action: () => convertLegacyAiSingleRequest({ ...privateRequest, apiKey: credential, cliPath: executable }, privateOptions),
      code: 'invalid_legacy_ai_input', message: '旧 AI 单次请求字段无效' },
    { action: () => convertLegacyAiSingleRequest({ ...privateRequest, requestId: credential }, privateOptions),
      code: 'unsupported_legacy_ai_fields', message: '旧单次请求的超时或请求身份没有等价公开字段' },
    { action: () => convertLegacyAiSingleRequest(privateRequest, { projectBindings: {} }),
      code: 'unbound_legacy_ai_project', message: '旧 AI 项目目录没有显式公开项目绑定' },
    { action: () => convertLegacyAiSingleRequest(privateRequest, { projectBindings: { [privateDirectory]: credential } }),
      code: 'invalid_legacy_ai_bindings', message: 'AI 目录与公开项目身份绑定无效' },
    { action: () => convertLegacyAiSingleRequest({ ...privateRequest, userPrompt: `${privatePrompt}${'x'.repeat(131073)}` }, privateOptions),
      code: 'invalid_ai_input', message: 'AI 项目、提示词或线程身份无效' },
  ];
  for (const scenario of cases) {
    assert.throws(scenario.action, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'protocol');
      assert.equal(error.code, scenario.code);
      assert.equal(error.message, scenario.message);
      assert.equal(error.logId, null);
      assert.equal(error.status, null);
      assert.equal(error.retryAfter, null);
      const diagnostics = [String(error), error.message, error.stack ?? '', JSON.stringify(error)];
      for (const diagnostic of diagnostics) {
        for (const marker of [privateDirectory, privatePrompt, credential, executable]) {
          assert.equal(diagnostic.includes(marker), false);
        }
      }
      return true;
    });
  }
  assert.equal(logged, 0);
  assert.equal(fetched, 0);
});

test('纯转换零任务调用，只有调用者显式single才提交一次公开输入并保留真实日志', async () => {
  const submissions: { operation: string; input: JsonData; signal: AbortSignal }[] = [];
  let queries = 0;
  let cancellations = 0;
  const threadId = '12345678-1234-1234-1234-123456789abc';
  const gateway: JobGateway = {
    submit: async (operation, input, abort) => {
      submissions.push({ operation, input, signal: abort });
      return { data: { id: 'legacy-ai-job', operation, status: 'succeeded', error: null,
        result: { result: { project_id: 'Demo_2-open', text: '完成', thread_id: threadId,
          events: [{ type: 'thread.started', thread_id: threadId },
            { type: 'item.completed', item: { type: 'agent_message', text: '完成' } }, { type: 'turn.completed' }] },
        artifacts: [] } }, logId: 'legacy-ai-log' };
    },
    getJob: async () => { queries++; throw new Error('终态单次任务不应额外查询'); },
    cancelJob: async () => { cancellations++; throw new Error('转换不得隐式取消任务'); },
  };
  const assistant = createAiAssistant(gateway);
  try {
    const converted = convertLegacyAiSingleRequest(request, options);
    assertProtocolError(() => convertLegacyAiSingleRequest({ ...request, timeoutMs: undefined }, options),
      'unsupported_legacy_ai_fields');
    assertProtocolError(() => convertLegacyAiSingleRequest(request, { projectBindings: {} }), 'unbound_legacy_ai_project');
    assert.equal(submissions.length, 0);
    assert.equal(queries, 0);
    assert.equal(cancellations, 0);
    const controller = new AbortController();
    const abort = controller.signal;
    const outcome = await assistant.single(converted, abort);
    assert.equal(submissions.length, 1);
    const submitted = submissions[0];
    assert.ok(submitted);
    assert.equal(submitted.operation, 'plugin.ai-assistant.cli.single');
    assert.deepEqual(submitted.input, { project_id: 'Demo_2-open', prompt: userPrompt });
    assert.ok(submitted.signal instanceof AbortSignal);
    assert.equal(submitted.signal.aborted, false);
    controller.abort();
    assert.equal(submitted.signal.aborted, true);
    assert.equal(outcome.data.project_id, 'Demo_2-open');
    assert.equal(outcome.data.thread_id, threadId);
    assert.equal(outcome.logId, 'legacy-ai-log');
    assert.equal(queries, 0);
    assert.equal(cancellations, 0);
  } finally {
    assistant.dispose();
  }
});
